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

export async function logActivity({ ownerId, actorId, actorEmail, actorName, action, description, metadata }: LogParams) {
  const supabase = createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from('activity_logs').insert({
    business_owner_id: ownerId,
    actor_id: actorId,
    actor_email: actorEmail,
    actor_name: actorName ?? actorEmail,
    action,
    description,
    metadata: metadata ?? null,
  });
}
