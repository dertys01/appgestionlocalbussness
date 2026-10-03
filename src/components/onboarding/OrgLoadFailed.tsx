'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';

// ── Fallback org absente ──
// Lecture de la boutique en échec : réseau coupé, projet Supabase en pause,
// policy refusée. On ne propose PAS de recréer la boutique — elle existe.
export function OrgLoadFailed({ error }: { error: string }) {
  const { supabase, refreshOrg } = useSupabase();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    await refreshOrg();
    setRetrying(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm text-center space-y-4">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
        <h1 className="text-xl font-bold text-slate-800">Lecture de la boutique impossible</h1>
        <p className="text-slate-600 text-sm">
          Votre boutique existe, mais elle n&apos;a pas pu être chargée.
          Réessayez avant toute chose — ne créez pas un second établissement.
        </p>
        <p className="text-red-600 text-xs break-words">{error}</p>
        <div className="space-y-2">
          <Button
            onClick={retry}
            disabled={retrying}
            className="w-full bg-indigo-600 hover:bg-indigo-700"
          >
            {retrying ? 'Nouvelle tentative…' : 'Réessayer'}
          </Button>
          <button
            onClick={() => supabase.auth.signOut()}
            className="w-full text-sm text-slate-400 hover:text-slate-600 underline"
          >
            Se déconnecter
          </button>
        </div>
      </div>
    </div>
  );
}
