import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requirePatron } from '@/lib/utils/user-client';
import { getPrestataire } from '@/lib/payments';
import { requireEnv, serverError } from '@/lib/utils/server';

/**
 * POST /api/payments/callback/[provider] — le webhook, unique porte
 * d'activation d'une période prépayée.
 *
 * Le chemin complet :
 *   1. le nom dans l'URL doit être LA passerelle configurée — un prestataire
 *      qui n'est pas celui qu'on utilise n'a rien à nous dire ;
 *   2. verifierCallback() valide la forme et la signature — retourne null si
 *      le prestataire n'est pas branché : refus net (fail closed) ;
 *   3. bac à sable uniquement : session authentifiée ET commande
 *      appartenant à l'appelant·e (il n'y a pas de signature à vérifier,
 *      la session fait foi ; PAYMENTS_SANDBOX=1 est vérifié dans le
 *      prestataire lui-même) ;
 *   4. activate_prepaid_plan() en service_role : seule écriture possible du
 *      statut « payée » et de l'échéance du plan — idempotente en base, les
 *      webhooks rejoués ne doublent rien.
 *
 * Aucune de ces étapes ne saute. Un webhook inconnu, non signé ou envoyé
 * par la mauvaise passerelle ressort en erreur, sans effet de bord.
 */

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');

function adminClientOrNull() {
  const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cle) return null;
  return createClient(SUPABASE_URL, cle, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider: nom } = await params;
    if (nom !== 'sandbox' && nom !== 'fedapay' && nom !== 'paydunya') {
      return NextResponse.json({ error: 'Passerelle inconnue' }, { status: 404 });
    }

    // Le webhook ne peut venir que de la passerelle configurée. Pas de
    // « mais j'ai envoyé le bon corps » : la configuration tranche.
    const actif = getPrestataire();
    if (actif.id !== nom) {
      return NextResponse.json({ error: 'Passerelle non configurée' }, { status: 404 });
    }

    const corps = await req.text();
    const confirmation = actif.verifierCallback(corps, req.headers);
    if (!confirmation || !confirmation.ok) {
      // Prestataire non branché (squelette), signature absente, corps
      // malformé : même réponse, aucun effet de bord.
      return NextResponse.json({ error: 'Callback refusé' }, { status: 400 });
    }

    // Bac à sable : pas de signature — la session fait foi. Pour les
    // vrais prestataires, la signature de l'étape précédente suffit et ce
    // bloc ne s'exécute pas.
    let proprio: string | null = null;
    if (nom === 'sandbox') {
      const auth = await requirePatron(req, 'Commande non autorisée');
      if ('error' in auth) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
      }
      proprio = auth.user.id;
    }

    const admin = adminClientOrNull();
    if (!admin) {
      return NextResponse.json({ error: 'Paiement indisponible pour le moment' }, { status: 503 });
    }

    const { data: commande, error: errLecture } = await admin
      .from('payment_orders')
      .select('user_id')
      .eq('reference', confirmation.reference)
      .maybeSingle();
    if (errLecture) throw errLecture;
    if (!commande) {
      return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 });
    }
    if (proprio !== null && commande.user_id !== proprio) {
      // Jeton de commande volé ou deviné : il n'appartient pas à
      // l'appelant·e, donc rien ne s'active.
      return NextResponse.json({ error: 'Cette commande n’est pas la vôtre' }, { status: 403 });
    }

    const { data: active, error: errActivation } = await admin.rpc('activate_prepaid_plan', {
      p_reference: confirmation.reference,
    });
    if (errActivation) throw errActivation;

    return NextResponse.json({ activated: active === true });
  } catch (e) {
    return NextResponse.json(serverError('payments/callback', e), { status: 500 });
  }
}
