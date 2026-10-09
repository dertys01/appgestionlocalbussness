import { createClient } from '@/lib/supabase/client';

interface LogParams {
  ownerId: string;
  actorId: string;
  actorEmail: string;
  actorName?: string | null;
  action: string;
  description: string;
  metadata?: Record<string, unknown>;
}

/** Une purge sur 20 écritures de journal suffit largement à retenir 90 jours. */
const PRUNE_EVERY_N = 20;

export async function logActivity({ ownerId, actorId, actorEmail, actorName, action, description, metadata }: LogParams) {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  const { error } = await db.from('activity_logs').insert({
    business_owner_id: ownerId,
    actor_id: actorId,
    actor_email: actorEmail,
    actor_name: actorName ?? actorEmail,
    action,
    description,
    metadata: metadata ?? null,
  });
  if (error) console.error('[activity] Échec écriture journal', error);

  // Nettoyage des logs > 90 jours pour cet owner. Échantillonné (1 vente sur
  // PRUNE_EVERY_N) pour ne pas ajouter un aller-retour réseau à chaque encaissement.
  // `await` obligatoire : les builders Supabase sont des thenables lazy, sans
  // `await` la requête n'est jamais exécutée.
  if (Math.random() * PRUNE_EVERY_N < 1) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    await db
      .from('activity_logs')
      .delete()
      .eq('business_owner_id', ownerId)
      .lt('created_at', cutoff.toISOString());
  }
}
