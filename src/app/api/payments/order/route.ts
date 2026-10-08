import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requirePatron } from '@/lib/utils/user-client';
import { montantPeriode } from '@/lib/utils/plans';
import { getPrestataire } from '@/lib/payments';
import { requireEnv, sanitizeError, serverError } from '@/lib/utils/server';

/**
 * POST /api/payments/order — commander une période prépayée (Mobile Money).
 *
 * Deux règles tiennent toute la route :
 *
 * 1. LE MONTANT NE VIENT PAS DU NAVIGATEUR. Il est recalculé par
 *    montantPeriode() depuis la même configuration que la page /tarifs
 *    (NEXT_PUBLIC_PLANS_CONFIG). Un corps « montant: 1 » reçoit le prix
 *    réel — ou la même 503 que tout le monde si aucun prix n'est
 *    configuré : jamais de chiffre inventé, jamais de prix codé en dur.
 *
 * 2. LE NAVIGATEUR N'ÉCRIT PAS DE COMMANDE. payment_orders est révoqué à
 *    authenticated (migration_mobilemoney.sql) : c'est la route, après
 *    requirePatron(), qui insère en service_role. La commande naît en
 *    « pending » ; seul un webhook vérifié la passe en « payée ».
 *
 * GET : l'état d'une commande, pour la page de paiement et le retour
 * d'écran. La policy orders_select_own filtre de toute façon les commandes
 * qui n'appartiennent pas à l'appelant·e.
 */

const Corps = z.object({
  plan: z.enum(['starter', 'pro']),
  mois: z.union([z.literal(1), z.literal(3), z.literal(12)]),
});

const Ref = z.string().regex(/^[a-f0-9]{36}$/, 'Référence invalide');

// Constante de module : NEXT_PUBLIC_SUPABASE_URL est présente partout. La
// clé service role, elle, est lue dans le handler (voir register/route.ts).
const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');

/** Client admin, ou null si la clé service role n'est pas configurée. */
function adminClientOrNull() {
  const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cle) return null;
  return createClient(SUPABASE_URL, cle, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const INDISPONIBLE = 'Paiement indisponible pour le moment';

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePatron(req, 'Seul le patron peut souscrire une période');
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const parse = Corps.safeParse(await req.json().catch(() => null));
    if (!parse.success) {
      return NextResponse.json({ error: 'Demande invalide' }, { status: 400 });
    }
    const { plan, mois } = parse.data;

    const montant = montantPeriode(plan, mois);
    if (montant === null) {
      return NextResponse.json({ error: INDISPONIBLE }, { status: 503 });
    }

    const admin = adminClientOrNull();
    if (!admin) return NextResponse.json({ error: INDISPONIBLE }, { status: 503 });

    const prestataire = getPrestataire();
    const reference = randomBytes(18).toString('hex');

    // La commande d'abord, le prestataire ensuite : si la création échoue,
    // la commande reste « pending » sans référence externe et expire
    // d'elle-même (expires_at) — pas de statut à nettoyer à la main, et
    // surtout aucune écriture qui repasserait par le navigateur.
    const { error: errCmd } = await admin.from('payment_orders').insert({
      user_id: auth.user.id,
      plan,
      period_months: mois,
      amount: montant,
      provider: prestataire.id,
      reference,
    });
    if (errCmd) throw errCmd;

    let paiement;
    try {
      paiement = await prestataire.creerPaiement({ reference, plan, mois, montant });
    } catch (e) {
      // Détail technique dans les logs serveur, jamais dans la réponse :
      // « indisponible » vaut mieux qu'un nom de passerelle cassé.
      console.error('[payments] creerPaiement :', sanitizeError(e));
      return NextResponse.json({ error: INDISPONIBLE }, { status: 503 });
    }

    const { error: errRef } = await admin
      .from('payment_orders')
      .update({ provider_ref: paiement.providerRef })
      .eq('reference', reference);
    if (errRef) throw errRef;

    return NextResponse.json({ reference, redirectUrl: paiement.redirectUrl });
  } catch (e) {
    return NextResponse.json(serverError('payments/order', e), { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePatron(req, 'Seul le patron peut consulter ses commandes');
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const ref = req.nextUrl.searchParams.get('ref') ?? '';
    if (!Ref.safeParse(ref).success) {
      return NextResponse.json({ error: 'Référence invalide' }, { status: 400 });
    }

    const { data, error } = await auth.db
      .from('payment_orders')
      .select('reference, plan, period_months, amount, status, created_at, paid_at, expires_at')
      .eq('reference', ref)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 });

    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(serverError('payments/order/get', e), { status: 500 });
  }
}
