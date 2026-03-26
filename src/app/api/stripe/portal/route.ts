import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!stripeKey || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'Configuration Stripe manquante' }, { status: 500 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stripe = new Stripe(stripeKey, { apiVersion: '2026-03-25.dahlia' as any });
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!jwt) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await adminClient.auth.getUser(jwt);
    if (authError || !user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const { data: sub } = await adminClient
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('org_id', user.id)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return NextResponse.json({ error: 'Aucun abonnement actif' }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await (stripe.billingPortal.sessions as any).create({
      customer: sub.stripe_customer_id,
      return_url: APP_URL,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
