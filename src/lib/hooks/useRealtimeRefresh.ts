import { useEffect, useRef } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Rafraîchissement temps réel multi-caisses (Supabase Realtime).
 *
 * Quand une AUTRE caisse — ou un autre appareil du même tenant — écrit dans
 * l'une des `tables`, `onChange` est appelé, après un court debounce qui
 * regroupe la rafale d'écritures d'une même vente (sales, puis products, puis
 * le journal). Le serveur Realtime applique la RLS : un abonné ne reçoit que
 * les lignes qu'il peut déjà lire, et le filtre `user_id` restreint au tenant.
 *
 * INERTE tant que `NEXT_PUBLIC_REALTIME` ne vaut pas « 1 ». C'est un choix
 * d'exploitation — une connexion WebSocket par onglet ouvert, facturée par
 * Supabase — donc on n'ouvre aucun canal sans un accord explicite.
 *
 * Ce n'est PAS un état local fusionné : la base reste la seule source de
 * vérité, et le rafraîchissement relit les mêmes fonctions que d'habitude.
 * Un événement manqué (reconnexion) ne laisse donc jamais un chiffre faux,
 * seulement un écran en retard jusqu'au prochain geste.
 */
const ACTIF = process.env.NEXT_PUBLIC_REALTIME === '1';

export function useRealtimeRefresh(tables: string[], onChange: () => void) {
  const { supabase, ownerId } = useSupabase();
  // La fonction de rafraîchissement change à chaque rendu ; on la lit par une
  // ref (mise à jour dans un effet, jamais pendant le rendu) pour ne pas
  // réabonner le canal à chaque fois.
  const cbRef = useRef(onChange);
  useEffect(() => { cbRef.current = onChange; });
  // Clé stable : l'identité du tableau `tables` change à chaque rendu.
  const cle = tables.join(',');

  useEffect(() => {
    if (!ACTIF || !ownerId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const declencher = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), 400);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let canal: any = supabase.channel(`gl:${cle}:${ownerId}`);
    for (const table of cle.split(',')) {
      canal = canal.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `user_id=eq.${ownerId}` },
        declencher,
      );
    }
    canal.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(canal);
    };
  }, [supabase, ownerId, cle]);
}
