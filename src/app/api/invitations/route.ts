import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { PLAN_LIMITS, planEffectif } from '@/lib/utils/plans';
import { serverError } from '@/lib/utils/server';
import { z } from 'zod';
import type { Plan } from '@/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requirePatron } from '@/lib/utils/user-client';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');

const INVITATION_DAYS = 7;
const MAX_PENDING = 20;

// Seul·e le·la patron·ne invite : requirePatron() (user-client.ts) compare
// l'identité de l'appelant à get_business_owner_id() — partagé avec les
// routes Mobile Money, qui posent la même question pour un autre geste.
const MSG_PATRON = 'Seul le patron peut inviter des employés';

/**
 * Combien de postes sont occupés : membres de l'équipe + invitations en attente.
 *
 * Une invitation en attente occupe un poste, sinon on prometrait plus de caisses
 * que le plan n'en autorise.
 */
async function postesOccupes(db: SupabaseClient, ownerId: string) {
  const [{ count: membres }, { count: enAttente }] = await Promise.all([
    db.from('business_members').select('*', { count: 'exact', head: true }).eq('owner_id', ownerId),
    db.from('employee_invitations').select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId).is('accepted_at', null),
  ]);
  return (membres ?? 0) + (enAttente ?? 0);
}

// GET : invitations en attente du patron
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePatron(req, MSG_PATRON);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    // `employee_invitations` porte une policy FOR ALL sur `auth.uid() =
    // owner_id` : le patron gère ses invitations avec sa propre session, sans
    // clé service role.
    const { data, error } = await auth.db
      .from('employee_invitations')
      .select('id, email, role, created_at, expires_at')
      .eq('owner_id', auth.user.id)
      .is('accepted_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Purge des invitations déjà consommées : une fois le lien utilisé, il ne
    // sert plus à rien et garde un email et une empreinte en base. La fonction
    // est recentrée sur la boutique de l'appelant et refuse tout autre
    // identifiant, donc l'appel se fait avec la session du patron — sans clé
    // service role.
    //
    // Fire-and-forget assumé : un échec ne doit pas priver le patron de la liste
    // de ses invitations en attente. Le nettoyage est un confort, pas une
    // condition d'affichage.
    auth.db.rpc('purge_accepted_invitations', { p_owner_id: auth.user.id })
      .then(() => {}, () => {});

    return NextResponse.json({
      invitations: data ?? [],
      appUrl: APP_URL ?? null,
    });
  } catch (e) {
    return NextResponse.json(serverError('invitations', e), { status: 500 });
  }
}

// POST : le patron invite un employé et reçoit le lien à lui transmettre
export async function POST(req: NextRequest) {
  try {
    const auth = await requirePatron(req, MSG_PATRON);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const parsedBody = z
      .object({
        email: z.string().email('Adresse email invalide'),
        role: z.enum(['employee', 'manager']).optional().default('employee'),
      })
      .safeParse(await req.json().catch(() => null));
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Adresse email invalide' }, { status: 400 });
    }

    const clean = parsedBody.data.email.trim().toLowerCase();
    const role = parsedBody.data.role;

    // Un lien en attente pour la même adresse : on le renvoie plutôt que d'en
    // créer un second. Deux liens actifs pour un employé, c'est deux occasions
    // de diffuser un accès par erreur.
    const { data: existing } = await auth.db
      .from('employee_invitations')
      .select('id, email, token, expires_at')
      .eq('owner_id', auth.user.id)
      .eq('email', clean)
      .is('accepted_at', null)
      .maybeSingle();

    if (existing && new Date(existing.expires_at) > new Date()) {
      // La table ne contient plus le jeton en clair (hash sha256) : on ne peut
      // pas reconstruire l'ancien lien, on en régénère un — un seul lien actif
      // pour la même adresse, comme avant.
      const newToken = randomBytes(32).toString('base64url');
      const newHash = createHash('sha256').update(newToken).digest('hex');
      const newExpiry = new Date(Date.now() + INVITATION_DAYS * 86400_000).toISOString();
      const { error: updErr } = await auth.db
        .from('employee_invitations')
        .update({ token: newHash, role, expires_at: newExpiry })
        .eq('id', existing.id);
      if (updErr) throw updErr;
      return NextResponse.json({
        success: true,
        reused: true,
        url: invitationUrl(req, newToken),
        expiresAt: newExpiry,
      });
    }

    // Garde-fou contre l'accumulation : 20 liens en attente pour un patron, c'est
    // une fuite ou une boucle, pas un usage normal.
    const { count } = await auth.db
      .from('employee_invitations')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', auth.user.id)
      .is('accepted_at', null);

    if ((count ?? 0) >= MAX_PENDING) {
      return NextResponse.json(
        { error: `Vous avez déjà ${count} invitation(s) en attente. Révoquez-les avant d'en créer d'autres.` },
        { status: 429 }
      );
    }

    // La limite du plan compte les invitations en attente comme des postes
    // occupés : sinon on promet plus de caisses que le plan n'en autorise.
    const [{ data: org }, occupes] = await Promise.all([
      auth.db.from('organizations').select('plan, trial_ends_at, plan_valid_until').eq('id', auth.user.id).maybeSingle(),
      postesOccupes(auth.db, auth.user.id),
    ]);

    // Plan EFFECTIF : pendant l'essai de 14 jours, le plan utile est starter.
    // check_employee_limit() en base pense pareil — si cette couche restait sur
    // le plan brut, elle refuserait un poste que le trigger accepterait (ou
    // l'inverse). Le refus principal reste le trigger ; celui-ci est la politesse.
    const plan = planEffectif((org?.plan ?? 'free') as Plan, org?.trial_ends_at, org?.plan_valid_until);
    const limit = PLAN_LIMITS[plan].employees;
    if (limit !== Infinity && occupes >= limit) {
      return NextResponse.json(
        { error: `Limite d'employés atteinte pour le plan ${plan} (max ${limit}). Passez au plan supérieur dans Paramètres.` },
        { status: 403 }
      );
    }

    // 32 octets aléatoires : le lien est transmis sur WhatsApp, il ne doit pas
    // pouvoir être deviné. Base64url évite les caractères à échapper dans une URL.
    const token = randomBytes(32).toString('base64url');

    // On ne stocke que le hash : une fuite de la table ou d'une sauvegarde
    // n'expose alors aucun lien utilisable. Le RPC et la route d'acceptation
    // comparent la même empreinte.
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const { data: inv, error: insertError } = await auth.db
      .from('employee_invitations')
      .insert({
        owner_id: auth.user.id,
        email: clean,
        role,
        token: tokenHash,
        expires_at: new Date(Date.now() + INVITATION_DAYS * 86400_000).toISOString(),
      })
      .select('id, email, expires_at')
      .single();

    if (insertError) throw insertError;

    return NextResponse.json({
      success: true,
      url: invitationUrl(req, token),
      expiresAt: inv.expires_at,
    });
  } catch (e) {
    return NextResponse.json(serverError('invitations', e), { status: 500 });
  }
}

// DELETE : révoquer une invitation (le lien ne fonctionne plus)
export async function DELETE(req: NextRequest) {
  try {
    const auth = await requirePatron(req, MSG_PATRON);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Identifiant manquant' }, { status: 400 });

    // Le owner_id dans le WHERE : sans lui, un patron pourrait révoquer
    // l'invitation d'un autre en devinant l'identifiant. La policy
    // `invitations_owner_write` rend ce filtre obligatoire de toute façon.
    const { error } = await auth.db
      .from('employee_invitations')
      .delete()
      .eq('id', id)
      .eq('owner_id', auth.user.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(serverError('invitations', e), { status: 500 });
  }
}

// Base du lien : NEXT_PUBLIC_APP_URL si configurée, sinon l'origine de la
// requête. L'ancien repli était une URL de PRODUCTION codée en dur — un
// déploiement de test (ou un local sans variable) envoyait les employés vers la
// mauvaise application. `req.nextUrl.origin` suit l'hôte réellement appelé.
function invitationUrl(req: NextRequest, token: string): string {
  const base = (APP_URL || req.nextUrl.origin).replace(/\/$/, '');
  return `${base}/invitation/${token}`;
}