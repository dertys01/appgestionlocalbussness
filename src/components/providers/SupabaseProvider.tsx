'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Organization, Plan } from '@/types';

interface SupabaseContextType {
  supabase: SupabaseClient;
  user: User | null;
  loading: boolean;
  ownerId: string | null;
  isEmployee: boolean;
  actorName: string | null;
  org: Organization | null;
  plan: Plan;
  refreshOrg: () => Promise<void>;
}

const SupabaseContext = createContext<SupabaseContextType | null>(null);

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [isEmployee, setIsEmployee] = useState(false);
  const [actorName, setActorName] = useState<string | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [plan, setPlan] = useState<Plan>('free');

  const loadOrg = async (ownerIdVal: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('organizations')
        .select('*')
        .eq('id', ownerIdVal)
        .maybeSingle();
      if (data) {
        setOrg(data as Organization);
        setPlan((data as Organization).plan);
      }
    } catch { /* silencieux */ }
  };

  const refreshOrg = async () => {
    if (ownerId) await loadOrg(ownerId);
  };

  const resolveMembership = async (u: User) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('business_members')
        .select('owner_id, member_name')
        .eq('member_id', u.id)
        .maybeSingle() as { data: { owner_id: string; member_name: string } | null };

      let resolvedOwnerId: string;
      let resolvedName: string;

      if (data) {
        resolvedOwnerId = data.owner_id;
        resolvedName = data.member_name;
        setOwnerId(resolvedOwnerId);
        setIsEmployee(true);
        setActorName(resolvedName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from('activity_logs').insert({
          business_owner_id: resolvedOwnerId,
          actor_id: u.id,
          actor_email: u.email ?? '',
          actor_name: resolvedName,
          action: 'login',
          description: `${resolvedName} s'est connecté(e)`,
        });
      } else {
        resolvedOwnerId = u.id;
        resolvedName = u.email ?? u.id;
        setOwnerId(resolvedOwnerId);
        setIsEmployee(false);
        setActorName(resolvedName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from('activity_logs').insert({
          business_owner_id: resolvedOwnerId,
          actor_id: u.id,
          actor_email: u.email ?? '',
          actor_name: resolvedName,
          action: 'login',
          description: 'Connexion patron',
        });
      }

      await loadOrg(resolvedOwnerId);
    } catch { /* silencieux — ne jamais bloquer l'app */ }
  };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user ?? null;
      setUser(u);
      if (u) {
        resolveMembership(u).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u && event === 'SIGNED_IN') {
        resolveMembership(u);
      }
      if (!u) {
        setOwnerId(null);
        setIsEmployee(false);
        setActorName(null);
        setOrg(null);
        setPlan('free');
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SupabaseContext.Provider value={{ supabase, user, loading, ownerId, isEmployee, actorName, org, plan, refreshOrg }}>
      {children}
    </SupabaseContext.Provider>
  );
}

export function useSupabase() {
  const ctx = useContext(SupabaseContext);
  if (!ctx) throw new Error('useSupabase doit être utilisé dans <SupabaseProvider>');
  return ctx;
}
