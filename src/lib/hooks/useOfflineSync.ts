import { useCallback, useEffect, useState } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import {
  EVENEMENT_FILE_HORS_LIGNE,
  compterFile,
  lireFile,
  retirerDeFile,
} from '@/lib/offline/queue';

/**
 * Rejeu des ventes encaissées hors-ligne (P7).
 *
 * Au retour du réseau (événement `online`), les ventes de la file sont
 * rejouées via `create_sale()` — la référence `client_ref` les rend
 * idempotentes, donc un rejeu après une réponse perdue ne double rien.
 *
 * Une vente dont le rejeu échoue (stock insuffisant, refus métier) RESTE dans
 * la file : elle ne doit jamais disparaître sans trace. Elle sera rejouée, ou
 * signalée par le compteur « en attente » — jamais avalée en silence.
 *
 * `onRejoue` : appelé après un rejeu réussi, pour rafraîchir catalogue et
 * chiffres du jour (le stock a bougé).
 */
export function useOfflineSync(onRejoue?: () => void) {
  const { supabase, ownerId } = useSupabase();
  const [enAttente, setEnAttente] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const rafraichirCompteur = useCallback(async () => {
    setEnAttente(await compterFile());
  }, []);

  const synchroniser = useCallback(async () => {
    if (!ownerId) return;
    const file = await lireFile();
    if (file.length === 0) return;

    setSyncing(true);
    let rejoue = 0;
    try {
      for (const vente of file) {
        const { error } = await supabase.rpc('create_sale', vente.payload);
        if (!error) {
          await retirerDeFile(vente.ref);
          rejoue += 1;
        }
      }
    } finally {
      setSyncing(false);
      await rafraichirCompteur();
      if (rejoue > 0) onRejoue?.();
    }
  }, [supabase, ownerId, rafraichirCompteur, onRejoue]);

  useEffect(() => {
    void rafraichirCompteur();
    const surLigne = () => { void synchroniser(); };
    const surChangement = () => { void rafraichirCompteur(); };
    window.addEventListener('online', surLigne);
    window.addEventListener(EVENEMENT_FILE_HORS_LIGNE, surChangement);
    return () => {
      window.removeEventListener('online', surLigne);
      window.removeEventListener(EVENEMENT_FILE_HORS_LIGNE, surChangement);
    };
  }, [rafraichirCompteur, synchroniser]);

  return { enAttente, syncing, synchroniser, rafraichirCompteur };
}
