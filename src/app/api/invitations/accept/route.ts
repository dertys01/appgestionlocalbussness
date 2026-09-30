import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { serverError, requireEnv } from '@/lib/utils/server';

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// POST : l'employé ouvre son lien, choisit son mot de passe, et rejoint la
// boutique du patron.
//
// Aucune authentification n'est requise : c'est le jeton qui fait foi. C'est
// pourquoi le contrôle décisif est dans redeem_invitation() — il vérifie que le
// compte correspond bien à l'email invité, en base, sous verrou.
export async function POST(req: NextRequest) {
  try {
    const { token, name, password } = await req.json();

    if (!token || !name || !password) {
      return NextResponse.json({ error: 'Lien, nom et mot de passe sont obligatoires' }, { status: 400 });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return NextResponse.json({ error: 'Le mot de passe doit faire au moins 6 caractères.' }, { status: 400 });
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Indiquez votre nom.' }, { status: 400 });
    }

    const adminClient = getAdminClient();

    // 1. L'invitation doit exister et être utilisable. On interroge la table
    //    pour connaître l'email invité : c'est lui qui détermine le compte à
    //    créer, et il ne vient pas du client (qui pourrait en envoyer un autre).
    const { data: inv, error: invError } = await adminClient
      .from('employee_invitations')
      .select('email, accepted_at, expires_at, owner_id')
      .eq('token', String(token))
      .maybeSingle();

    if (invError) throw invError;

    // Message volontairement identique à celui d'un jeton inconnu : un lien
    // révoqué ne doit pas être distinguable d'un lien inventé.
    if (!inv) {
      return NextResponse.json(
        { error: "Ce lien est invalide ou a expiré. Demandez un nouveau lien à votre patron." },
        { status: 404 }
      );
    }
    if (inv.accepted_at) {
      return NextResponse.json(
        { error: "Ce lien a déjà été utilisé. Demandez un nouveau lien à votre patron." },
        { status: 410 }
      );
    }
    if (new Date(inv.expires_at) < new Date()) {
      return NextResponse.json(
        { error: "Ce lien a expiré. Demandez un nouveau lien à votre patron." },
        { status: 410 }
      );
    }

    const email = String(inv.email).toLowerCase();

    // 2. Créer le compte. Si l'email existe déjà, ce n'est pas une invitation
    //    neuve : on ne réécrit jamais le mot de passe d'un compte existant,
    //    cela reviendrait à laisser quiconque detienne le lien s'approprier un
    //    accès existant.
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    let userId: string | undefined = created?.user?.id;
    let alreadyExisted = false;

    if (createError) {
      if (/already registered|already been registered|already exists/i.test(createError.message)) {
        alreadyExisted = true;
        // Compte existant : on retrouve son id par la liste. L'API de
        // recherche par email est hors service sur ce projet (incident en
        // cours), on repasse donc par une liste paginée.
        const existingId = await findUserIdByEmail(adminClient, email);
        if (!existingId) {
          return NextResponse.json(
            { error: "Un compte existe déjà avec cette adresse. Connectez-vous normalement, ou demandez un nouveau lien." },
            { status: 409 }
          );
        }
        userId = existingId;
      } else {
        // "Database error checking email" : l'API d'administration échoue sur
        // certaines lignes auth.users. Rien de ce que l'utilisateur peut faire
        // n'y remède, et dire "échec" sans plus nuirait à tout le monde.
        return NextResponse.json(
          { error: "Le service d'inscription est momentanément indisponible. Réessayez dans quelques minutes." },
          { status: 503 }
        );
      }
    }

    if (!userId) {
      return NextResponse.json({ error: "Impossible de créer le compte." }, { status: 500 });
    }

    // 3. Consommer l'invitation. La fonction est atomique et refait le contrôle
    //    email : c'est elle qui fait foi, même en cas de double soumission.
    const { data: redeemed, error: redeemError } = await adminClient.rpc('redeem_invitation', {
      p_token: String(token),
      p_member_id: userId,
      p_member_name: name.trim(),
    });

    if (redeemError) {
      // Le compte vient d'être créé mais n'est rattaché à personne : on le
      // supprime pour ne pas laisser un compte orphelin. Un compte préexistant
      // n'est en revanche jamais touché.
      if (!alreadyExisted) {
        await adminClient.auth.admin.deleteUser(userId).catch(() => {});
      }
      const msg = redeemError.message ?? '';
      if (/déjà (été )?utilisée/.test(msg)) {
        return NextResponse.json({ error: "Ce lien a déjà été utilisé." }, { status: 410 });
      }
      if (/expiré/.test(msg)) {
        return NextResponse.json({ error: "Ce lien a expiré." }, { status: 410 });
      }
      if (/introuvable|révoquée/.test(msg)) {
        return NextResponse.json({ error: "Ce lien est invalide." }, { status: 404 });
      }
      throw redeemError;
    }

    return NextResponse.json({
      success: true,
      email,
      member: redeemed?.[0] ?? null,
    });
  } catch (e) {
    return NextResponse.json(serverError('invitations/accept', e), { status: 500 });
  }
}

// L'API /admin/users?email= échoue sur ce projet ; on retrouve donc l'utilisateur
// en paginant la liste. On s'arrête dès qu'on trouve, et on borne le parcours
// pour ne pas boucler indéfiniment si l'utilisateur est introuvable.
async function findUserIdByEmail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminClient: any,
  email: string,
  maxPages = 50
): Promise<string | null> {
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 50 });
    if (error || !data?.users?.length) return null;
    const found = data.users.find(
      (u: { email?: string }) => (u.email ?? '').toLowerCase() === email
    );
    if (found) return found.id;
  }
  return null;
}
