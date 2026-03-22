'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SupabaseClient, User } from '@supabase/supabase-js';

interface SupabaseContextType {
  supabase: SupabaseClient;
  user: User | null;
  loading: boolean;
  ownerId: string | null;      // user_id du patron (= user.id pour le patron, = owner_id pour un employé)
  isEmployee: boolean;
  actorName: string | null;    // nom affiché dans les logs
}

const SupabaseContext = createContext<SupabaseContextType | null>(null);

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [isEmployee, setIsEmployee] = useState(false);
  const [actorName, setActorName] = useState<string | null>(null);

  const resolveMembership = async (u: User) => { try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from('business_members')
      .select('owner_id, member_name')
      .eq('member_id', u.id)
      .maybeSingle() as { data: { owner_id: string; member_name: string } | null };

    if (data) {
      setOwnerId(data.owner_id);
      setIsEmployee(true);
      setActorName(data.member_name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from('activity_logs').insert({
        business_owner_id: data.owner_id,
        actor_id: u.id,
        actor_email: u.email ?? '',
        actor_name: data.member_name,
        action: 'login',
        description: `${data.member_name} s'est connecté(e)`,
      });
    } else {
      setOwnerId(u.id);
      setIsEmployee(false);
      setActorName(u.email ?? null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from('activity_logs').insert({
        business_owner_id: u.id,
        actor_id: u.id,
        actor_email: u.email ?? '',
        actor_name: u.email ?? null,
        action: 'login',
        description: `Connexion patron`,
      });
    }
  } catch { /* silencieux — ne jamais bloquer l'app */ } };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user ?? null;
      setUser(u);
      setLoading(false); // ne jamais bloquer le chargement
      if (u) resolveMembership(u); // async, en arrière-plan
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u && event === 'SIGNED_IN') {
        resolveMembership(u); // async, en arrière-plan
      }
      if (!u) {
        setOwnerId(null);
        setIsEmployee(false);
        setActorName(null);
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SupabaseContext.Provider value={{ supabase, user, loading, ownerId, isEmployee, actorName }}>
      {children}
    </SupabaseContext.Provider>
  );
}

export function useSupabase() {
  const ctx = useContext(SupabaseContext);
  if (!ctx) throw new Error('useSupabase doit être utilisé dans <SupabaseProvider>');
  return ctx;
}
