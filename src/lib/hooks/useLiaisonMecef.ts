'use client';

import { useEffect, useState } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Ouvre-t-on la délivrance de factures normalisées (e-MECeF) ?
 *
 * Le jeton DGI est une variable serveur : le navigateur ne peut qu'en
 * demander le verdict à /api/mecef/status. La valeur NAÎT à false (verrou
 * fermé) et ne devient true qu'à la réponse explicite du serveur — un
 * échec réseau, une session absente ou un test sans serveur laissent la
 * caisse sur « facture non délivrée », jamais l'inverse.
 *
 * Une seule requête par montage, et l'écran Paramètres comme la caisse
 * montent le même hook : le verdict est posé une fois, pas recopié.
 */
export function useLiaisonMecef(): boolean {
  const { supabase } = useSupabase();
  const [branche, setBranche] = useState(false);

  useEffect(() => {
    let vivant = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) return;
        const res = await fetch('/api/mecef/status', {
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        });
        if (!res.ok) return;
        const json = (await res.json()) as { branche?: unknown };
        if (vivant && json?.branche === true) setBranche(true);
      } catch {
        // Hors-ligne, test sans serveur, session expirée : le verrou reste
        // fermé, c'est la position sûre.
      }
    })();
    return () => { vivant = false; };
  }, [supabase]);

  return branche;
}
