import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lmygvpruffpspixrsixh.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxteWd2cHJ1ZmZwc3BpeHJzaXhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjMyMzQsImV4cCI6MjA4OTY5OTIzNH0.mn8BSN2KpWBMCfvXBWpNpFqE5LJkG-XfCzQVIr3tKvM';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function verifyOwner(jwt: string) {
  const adminClient = getAdminClient();
  const { data: { user }, error } = await adminClient.auth.getUser(jwt);
  if (error || !user) return null;

  // Vérifie que c'est bien un patron (pas un employé)
  const { data: membership } = await adminClient
    .from('business_members')
    .select('owner_id')
    .eq('member_id', user.id)
    .maybeSingle();

  if (membership) return null; // employé → accès refusé
  return user;
}

// GET : liste des employés du patron
export async function GET(req: NextRequest) {
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
}

// POST : créer un employé
export async function POST(req: NextRequest) {
  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!jwt) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const owner = await verifyOwner(jwt);
  if (!owner) return NextResponse.json({ error: 'Seul le patron peut ajouter des employés' }, { status: 403 });

  const { email, password, name } = await req.json();
  if (!email || !password || !name) {
    return NextResponse.json({ error: 'Nom, email et mot de passe sont obligatoires' }, { status: 400 });
  }

  const adminClient = getAdminClient();

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
    .insert({ owner_id: owner.id, member_id: newUser.user.id, member_name: name });

  if (memberError) {
    await adminClient.auth.admin.deleteUser(newUser.user.id);
    return NextResponse.json({ error: memberError.message }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    member: { id: newUser.user.id, email, name },
  });
}
