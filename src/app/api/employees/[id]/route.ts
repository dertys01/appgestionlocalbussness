import { NextRequest, NextResponse } from 'next/server';
import { serverError } from '@/lib/utils/server';
import { z } from 'zod';
import { clientFor, readUser } from '@/lib/utils/user-client';

/**
 * Rôle et retrait d'un employé.
 *
 * Les écritures passent par deux fonctions SECURITY DEFINER
 * (`business_members_set_role`, `business_members_remove`) qui revérifient que
 * l'appelant est bien le patron concerné. La table n'a toujours AUCUNE
 * écriture client : sans ces fonctions, la seule façon d'écrire serait la clé
 * service role, qui contourne la RLS.
 *
 * Le garde « cet employé est dans MON équipe » n'est plus écrit ici : il est
 * dans la fonction, où il ne peut pas être oublié. La route ne conserve que
 * le contrôle de rôle — c'est-à-dire qui a le droit d'appeler.
 */

// PATCH : changer le rôle d'un membre (employee ↔ manager)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const parsed = z
      .object({ role: z.enum(['employee', 'manager']) })
      .safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Rôle invalide' }, { status: 400 });
    }

    const { id: memberId } = await params;
    const db = clientFor(req);

    // Un·e employé·e n'a pas d'équipe à gérer : get_business_owner_id()
    // renverrait son patron, et la fonction verrait l'équipe de quelqu'un
    // d'autre.
    const { data: patron, error: errPatron } = await db.rpc('get_business_owner_id');
    if (errPatron) throw errPatron;
    if (patron !== user.id) {
      return NextResponse.json({ error: 'Seul le patron peut gérer son équipe' }, { status: 403 });
    }

    const { error } = await db.rpc('business_members_set_role', {
      p_member_id: memberId,
      p_role: parsed.data.role,
    });
    // P0002 : la fonction ne trouve aucun membre de CETTE équipe chez cet
    // employé — donc pas « Employé introuvable », qui laisserait deviner
    // l'existence d'une équipe qui n'est pas la sienne.
    if (error) {
      if (error.code === 'P0002') {
        return NextResponse.json({ error: 'Employé introuvable' }, { status: 404 });
      }
      if (error.code === '22023') {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Mise à jour impossible' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(serverError('employees.patch', e), { status: 500 });
  }
}

// DELETE : supprimer un employé
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await readUser(req);
    if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

    const { id: memberId } = await params;
    const db = clientFor(req);

    const { data: patron, error: errPatron } = await db.rpc('get_business_owner_id');
    if (errPatron) throw errPatron;
    if (patron !== user.id) {
      return NextResponse.json({ error: 'Seul le patron peut gérer son équipe' }, { status: 403 });
    }

    const { error } = await db.rpc('business_members_remove', { p_member_id: memberId });

    if (error) {
      if (error.code === 'P0002') {
        return NextResponse.json({ error: 'Employé introuvable' }, { status: 404 });
      }
      if (error.code === '22023') {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Suppression impossible' }, { status: 500 });
    }

    // La fonction ne supprime QUE le lien de l'équipe, jamais le compte Auth :
    // organizations, products, sales et stock_logs partent tous en
    // ON DELETE CASCADE depuis auth.users. Supprimer le compte détruisait donc
    // la boutique entière du membre — ce qui est arrivé dans le cas d'un patron
    // invité comme employé ailleurs : son tenant basculait chez l'invitant,
    // qui pouvait ensuite « virer » un compte dont dépendait sa propre boutique.
    //
    // Le compte reste, sans lien : il ne voit plus rien et se reconnecte
    // normalement. Le poste occupé est bien libéré, puisque le plan compte
    // members + invitations en attente.
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(serverError('employees.delete', e), { status: 500 });
  }
}