import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

type Plan = 'free' | 'starter' | 'pro';

function normalizePlan(raw: unknown): Plan {
  return raw === 'starter' || raw === 'pro' ? raw : 'free';
}

/**
 * Depuis l'API Stripe 2026-03-25, `current_period_end` n'existe plus sur
 * l'objet `Subscription` : la période est portée par chaque `SubscriptionItem`.
 * Lire `sub.current_period_end` renvoie `undefined` et faisait planter
 * `toISOString()` — le client était débité mais restait sur le plan Free.
 */
function subscriptionPeriodEnd(sub: { items?: { data?: Array<{ current_period_end?: number }> } }): string | null {
  const ts = sub.items?.data?.[0]?.current_period_end;
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

export async function POST(req: NextRequest) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!stripeKey) return NextResponse.json({ error: 'STRIPE_SECRET_KEY manquant' }, { status: 500 });
  const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' });
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET ?? '');
  } catch {
    return NextResponse.json({ error: 'Webhook signature invalide' }, { status: 400 });
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventData = event.data.object as any;
  const orgId = eventData.metadata?.org_id ?? null;
  const activeStatuses = ['active', 'trialing'];

  // Log l'événement reçu (idempotent via event_id unique)
  await adminClient.from('webhook_events').upsert({
    event_id: event.id,
    event_type: event.type,
    org_id: orgId,
    status: 'received',
  }, { onConflict: 'event_id', ignoreDuplicates: true });

  let processError: string | null = null;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (!orgId) break;
        const plan = normalizePlan(eventData.metadata?.plan);
        const subId = eventData.subscription as string;
        const sub = await stripe.subscriptions.retrieve(subId);

        await adminClient.from('subscriptions').upsert({
          org_id: orgId,
          stripe_customer_id: eventData.customer as string,
          stripe_subscription_id: subId,
          plan,
          status: sub.status,
          current_period_end: subscriptionPeriodEnd(sub),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'org_id' });

        await adminClient.from('organizations').update({ plan }).eq('id', orgId);
        break;
      }

      case 'customer.subscription.updated': {
        if (!orgId) break;
        const plan = normalizePlan(eventData.metadata?.plan);
        const status = eventData.status as string;

        await adminClient.from('subscriptions').upsert({
          org_id: orgId,
          stripe_customer_id: (eventData.customer as string) ?? null,
          stripe_subscription_id: eventData.id,
          plan,
          status,
          current_period_end: subscriptionPeriodEnd(eventData),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'org_id' });

        const effectivePlan = activeStatuses.includes(status) ? plan : 'free';
        await adminClient.from('organizations').update({ plan: effectivePlan }).eq('id', orgId);
        break;
      }

      case 'customer.subscription.deleted': {
        if (!orgId) break;
        await adminClient.from('subscriptions').update({
          plan: 'free', status: 'canceled', updated_at: new Date().toISOString(),
        }).eq('org_id', orgId);
        await adminClient.from('organizations').update({ plan: 'free' }).eq('id', orgId);
        break;
      }
    }
  } catch (e) {
    processError = String(e);
    console.error('[Webhook] Erreur traitement', event.type, e);
  }

  // Mettre à jour le statut du log
  await adminClient.from('webhook_events').update({
    status: processError ? 'error' : 'processed',
    error: processError,
  }).eq('event_id', event.id);

  return NextResponse.json({ received: true });
}
