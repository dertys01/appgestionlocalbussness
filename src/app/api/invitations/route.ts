import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomBytes, createHash } from 'crypto';
import { PLAN_LIMITS } from '@/lib/utils/plans';
import { serverError, requireEnv } from '@/lib/utils/server';
import { z } from 'zod';
import type { Plan } from '@/types';

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');

const INVITATION_DAYS = 7;
const MAX_PENDING = 20;

function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Un·e employé·e ne gère pas l'équipe : get_business_owner_id() renverrait son
// patron, la vérification doit donc porter sur l'identité du patron lui-même.
async function requirePatron(req: NextRequest) {
  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!jwt) return { error: 'Non authentifié', status: 401 } as const;

  const adminClient = getAdminClient();
  const { data: { user }, error } = await adminClient.auth.getUser(jwt);
  if (error || !user) return { error: 'Non authentifié', status: 401 } as const;

  const { data: membership } = await adminClient
    .from('business_members')
    .select('owner_id')
    .eq('member_id', user.id)
    .maybeSingle();
  if (membership) return { error: 'Seul le patron peut inviter des employés', status: 403 } as const;

  return { user, adminClient } as const;
}

// GET : invitations en attente du patron
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePatron(req);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { data, error } = await auth.adminClient
      .from('employee_invitations')
      .select('id, email, role, created_at, expires_at')
      .eq('owner_id', auth.user.id)
      .is('accepted_at', null)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Purge opportuniste : les invitations consommées ne doivent pas vivre
    // indéfiniment (emails, jetons). Fire-and-forget : un échec ne bloque
    // pas l'écran de l'équipe.
    auth.adminClient.rpc('purge_accepted_invitations', {}).then(() => {}, () => {});

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
    const auth = await requirePatron(req);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const parsedBody = z
      .object({ email: z.string().email('Adresse email invalide') })
      .safeParse(await req.json().catch(() => null));
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Adresse email invalide' }, { status: 400 });
    }

    const clean = parsedBody.data.email.trim().toLowerCase();

    // Un lien en attente pour la même adresse : on le renvoie plutôt que d'en
    // créer un second. Deux liens actifs pour un employé, c'est deux occasions
    // de diffuser un accès par erreur.
    const { data: existing } = await auth.adminClient
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
      const { error: updErr } = await auth.adminClient
        .from('employee_invitations')
        .update({ token: newHash, expires_at: newExpiry })
        .eq('id', existing.id);
      if (updErr) throw updErr;
      return NextResponse.json({
        success: true,
        reused: true,
        url: invitationUrl(newToken),
        expiresAt: newExpiry,
      });
    }

    // Garde-fou contre l'accumulation : 20 liens en attente pour un patron, c'est
    // une fuite ou une boucle, pas un usage normal.
    const { count } = await auth.adminClient
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

    // La limite d'employés compte les invitations en attente comme des postes
    // occupés : sinon on promet plus de caisses que le plan n'en autorise.
    const [{ data: org }, { count: memberCount }, { count: pendingCount }] = await Promise.all([
      auth.adminClient.from('organizations').select('plan').eq('id', auth.user.id).maybeSingle(),
      auth.adminClient.from('business_members').select('*', { count: 'exact', head: true }).eq('owner_id', auth.user.id),
      auth.adminClient.from('employee_invitations').select('*', { count: 'exact', head: true })
        .eq('owner_id', auth.user.id).is('accepted_at', null),
    ]);

    const plan = (org?.plan ?? 'free') as Plan;
    const limit = PLAN_LIMITS[plan].employees;
    const occupied = (memberCount ?? 0) + (pendingCount ?? 0);
    if (limit !== Infinity && occupied >= limit) {
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

    const { data: inv, error: insertError } = await auth.adminClient
      .from('employee_invitations')
      .insert({
        owner_id: auth.user.id,
        email: clean,
        token: tokenHash,
        expires_at: new Date(Date.now() + INVITATION_DAYS * 86400_000).toISOString(),
      })
      .select('id, email, expires_at')
      .single();

    if (insertError) throw insertError;

    return NextResponse.json({
      success: true,
      url: invitationUrl(token),
      expiresAt: inv.expires_at,
    });
  } catch (e) {
    return NextResponse.json(serverError('invitations', e), { status: 500 });
  }
}

// DELETE : révoquer une invitation (le lien ne fonctionne plus)
export async function DELETE(req: NextRequest) {
  try {
    const auth = await requirePatron(req);
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Identifiant manquant' }, { status: 400 });

    // Le owner_id dans le WHERE : sans lui, un patron pourrait révoquer
    // l'invitation d'un autre en devinant l'identifiant.
    const { error } = await auth.adminClient
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

function invitationUrl(token: string): string {
  const base = APP_URL || 'https://appgestionlocalbussness.vercel.app';
  return `${base}/invitation/${token}`;
}
