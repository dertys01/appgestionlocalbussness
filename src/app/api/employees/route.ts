import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/utils/server';
import { clientFor, readUser } from '@/lib/utils/user-client';

/**
 * Liste des employés du patron.
 *
 * Cette route ne demande PLUS de clé service role : elle interroge la base
 * avec le jeton du patron, et la RLS fait son travail. C'était possible depuis
 * le début — `migration_security.sql` autorise le patron à lire sa propre
 * équipe (`owner_manage_members_select`, `auth.uid() = owner_id`) — mais la
 * clé service, qui contourne toutes les règles, était utilisée quand même.
 *
 * Elle n'était d'ailleurs nécessaire qu'ici et à la suppression d'un membre.
 * Les deux opérations d'écriture passent maintenant par des fonctions
 * SECURITY DEFINER qui revérifient l'appelant (migration_equipe_sans_service_role).
 */

// GET : liste des employés du patron
export async function GET(req: NextRequest) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const db = clientFor(req);

    // Un·e employé·e n'a pas d'équipe à lister : get_business_owner_id()
    // renverrait son patron et il verrait l'équipe de quelqu'un d'autre.
    const { data: patron, error: errPatron } = await db.rpc('get_business_owner_id');
    if (errPatron) throw errPatron;
    if (patron !== user.id) {
      return NextResponse.json({ error: 'Seul le patron peut voir son équipe' }, { status: 403 });
    }

    const { data, error } = await db
      .from('business_members')
      .select('id, member_id, member_name, role, created_at')
      .eq('owner_id', user.id)
      .order('created_at');

    if (error) throw error;

    return NextResponse.json({ members: data ?? [] });
  } catch (e) {
    return NextResponse.json(serverError('employees', e), { status: 500 });
  }
}

// POST : supprime.
//
// La creation d'un employe passe desormais par une invitation
// (POST /api/invitations, puis /invitation/[token]). Le patron ne fixe plus
// le mot de passe de son employe : il ne l'a jamais connu, donc il ne peut ni le
// transmettre par un canal non chiffre, ni l'oublier. C'etait le chemin le plus
// probable pour qu'un acces client soit compromis.
//
// DELETE /api/employees/[id] reste en place : retirer un employe de l'equipe
// est une autre operation.