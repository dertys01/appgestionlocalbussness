import { NextRequest, NextResponse } from 'next/server';
import { serverError, requireEnv } from '@/lib/utils/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

function getAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// DELETE : supprimer un employé
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!jwt) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const adminClient = getAdminClient();
    const { data: { user }, error } = await adminClient.auth.getUser(jwt);
    if (error || !user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const { id: memberId } = await params;

    // Vérifie que cet employé appartient bien à ce patron
    const { data: membership } = await adminClient
      .from('business_members')
      .select('id, member_id')
      .eq('owner_id', user.id)
      .eq('member_id', memberId)
      .maybeSingle();

    if (!membership) return NextResponse.json({ error: 'Employé introuvable' }, { status: 404 });

    // Supprime le lien, et rien d'autre.
    //
    // On ne supprime JAMAIS le compte Auth : organizations, products, sales,
    // stock_logs… tous partent en ON DELETE CASCADE depuis auth.users, la
    // suppression détruisait donc la boutique entière du membre. C'est arrivé
    // dans le cas d'un patron invité comme employé ailleurs — son tenant
    // basculait chez l'invitant, qui pouvait ensuite « virer » un compte dont
    // dépendait sa propre boutique.
    //
    // Le compte reste, sans lien : il ne voit plus rien, et l'utilisateur peut
    // se reconnecter normalement. Le poste occupé est bien libéré, puisque le
    // plan compte members + invitations en attente.
    const { error: delErr } = await adminClient
      .from('business_members')
      .delete()
      .eq('id', membership.id);
    if (delErr) return NextResponse.json({ error: 'Suppression impossible' }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(serverError('employees.delete', e), { status: 500 });
  }
}
