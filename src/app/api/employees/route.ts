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
    return NextResponse.json(serverError('employees', e), { status: 500 });
  }
}

// POST : supprime.
//
// La creation d'un employe passe desormais par une invitation
// (POST /api/invitations, puis /invitation/[token]). Le patron ne fixe plus le
// mot de passe de son employe : il ne l'a jamais connu, donc il ne peut ni le
// transmettre par un canal non chiffre, ni l'oublier. C'etait le chemin le plus
// probable pour qu'un acces client soit compromis.
//
// DELETE /api/employees/[id] reste en place : retirer un employe de l'equipe
// est une autre operation.
