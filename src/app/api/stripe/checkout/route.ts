import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { serverError, requireEnv } from '@/lib/utils/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  try {
    const stripeKey = requireEnv('STRIPE_SECRET_KEY');
    const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!stripeKey) {
      return NextResponse.json({ error: 'STRIPE_SECRET_KEY non configuré' }, { status: 500 });
    }
    if (!SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY non configuré' }, { status: 500 });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' });
    const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
    const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const PRICE_IDS: Record<string, string> = {
      starter: process.env.STRIPE_PRICE_STARTER ?? '',
      pro: process.env.STRIPE_PRICE_PRO ?? '',
    };

    const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!jwt) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await adminClient.auth.getUser(jwt);
    if (authError || !user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const { plan } = await req.json();
    if (plan !== 'starter' && plan !== 'pro') {
      return NextResponse.json({ error: 'Plan invalide.' }, { status: 400 });
    }
    const priceId = PRICE_IDS[plan];
    if (!priceId) return NextResponse.json({ error: 'Plan non configuré' }, { status: 400 });

    // Récupère ou crée le customer Stripe
    const { data: sub } = await adminClient
      .from('subscriptions')
      .select('stripe_customer_id, status')
      .eq('org_id', user.id)
      .maybeSingle();

    // Un abonnement déjà actif ne doit pas pouvoir en re-souscrire un second.
    if (sub?.status === 'active' || sub?.status === 'trialing') {
      return NextResponse.json(
        { error: 'Un abonnement est déjà actif. Gérez-le depuis le portail.' },
        { status: 409 }
      );
    }

    let customerId = sub?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { org_id: user.id },
      });
      customerId = customer.id;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await (stripe.checkout.sessions as any).create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${APP_URL}/?upgrade=success`,
      cancel_url: `${APP_URL}/?upgrade=cancel`,
      metadata: { org_id: user.id, plan },
      subscription_data: {
        metadata: { org_id: user.id, plan },
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json(serverError('stripe.checkout', e), { status: 500 });
  }
}
