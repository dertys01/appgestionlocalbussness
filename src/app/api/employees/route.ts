import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lmygvpruffpspixrsixh.supabase.co';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'SUPABASE_KEY_A_ROTATIONNER';

function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// GET : liste des employés du patron
export async function GET(req: NextRequest) {
  try {
    const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!jwt) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const adminClient = getAdminClient();
    const { data: { user }, error } = await adminClient.auth.getUser(jwt);
    if (error || !user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const { data } = await adminClient
      .from('business_members')
      .select('id, member_id, member_name, role, created_at')
      .eq('owner_id', user.id)
      .order('created_at');

    return NextResponse.json({ members: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST : créer un employé
export async function POST(req: NextRequest) {
  try {
    const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!jwt) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const adminClient = getAdminClient();

    // Vérifie l'identité du appelant
    const { data: { user }, error: authError } = await adminClient.auth.getUser(jwt);
    if (authError || !user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    // Vérifie que ce n'est pas un employé qui essaie d'ajouter quelqu'un
    const { data: membership } = await adminClient
      .from('business_members')
      .select('owner_id')
      .eq('member_id', user.id)
      .maybeSingle();
    if (membership) return NextResponse.json({ error: 'Seul le patron peut ajouter des employés' }, { status: 403 });

    const { email, password, name } = await req.json();
    if (!email || !password || !name) {
      return NextResponse.json({ error: 'Nom, email et mot de passe sont obligatoires' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Mot de passe : 6 caractères minimum' }, { status: 400 });
    }

    // Crée le compte sans confirmation email
    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError) {
      const msg = createError.message.includes('already registered')
        ? 'Cet email est déjà utilisé'
        : createError.message;
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Lie l'employé au patron
    const { error: memberError } = await adminClient
      .from('business_members')
      .insert({ owner_id: user.id, member_id: newUser.user.id, member_name: name });

    if (memberError) {
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return NextResponse.json({ error: memberError.message }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      member: { id: newUser.user.id, email, name },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
