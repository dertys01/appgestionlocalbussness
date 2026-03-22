import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://lmygvpruffpspixrsixh.supabase.co';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxteWd2cHJ1ZmZwc3BpeHJzaXhoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDEyMzIzNCwiZXhwIjoyMDg5Njk5MjM0fQ.GLtZ18nlhUETFG5ehL52LS_3_SeQKUK4ZwoBhBYGpvk';

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

    // Supprime le lien
    await adminClient.from('business_members').delete().eq('id', membership.id);

    // Supprime le compte Supabase Auth
    await adminClient.auth.admin.deleteUser(memberId);

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
