import { useEffect, useState } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { localTimeZone, todayISO } from '@/lib/utils/period';

/** Les chiffres du jour affichés sur l'accueil. */
export interface Today {
  /** Encaissé aujourd'hui (base de caisse : amount_received, dettes réglées comprises). */
  revenue: number;
  cash: number;
  momo: number;
  /** Nombre de ventes enregistrées aujourd'hui. */
  sales: number;
  /** Total encore dû par les clients, toutes dates confondues. */
  debtTotal: number;
  /** Nombre de clients qui doivent quelque chose. */
  debtClients: number;
}

/**
 * Les chiffres du jour, lus aux mêmes sources que les autres écrans :
 * get_sales_summary() comme le Journal du jour, get_customer_debts() comme
 * l'écran Dettes. Un seul chiffre par notion — un accueil qui dirait 34 000 F
 * quand le journal dit 42 000 F ferait douter des deux.
 *
 * `actif` : la lecture n'a lieu que lorsque l'accueil est affiché, et elle est
 * refaite à chaque retour — c'est ce qui le met à jour après une vente.
 */
export function useToday(actif: boolean) {
  const { supabase, user } = useSupabase();
  const [today, setToday] = useState<Today | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!actif || !user) return;
    // Même forme que useProducts : la lecture est asynchrone, et un accueil
    // quitté avant la réponse n'écrit pas dans un état périmé.
    let annule = false;
    (async () => {
      const jour = todayISO();
      const [ventes, dettes] = await Promise.all([
        supabase.rpc('get_sales_summary', { p_from: jour, p_to: jour, p_tz: localTimeZone() }),
        supabase.rpc('get_customer_debts'),
      ]);
      if (annule) return;
      if (ventes.error) {
        setError(ventes.error.message);
        return;
      }
      const ligne = ((ventes.data ?? []) as { revenue: number; cash: number; momo: number; tx: number }[])[0];
      // Le carnet ne doit pas faire tomber l'accueil : sans lui, on affiche le
      // reste et la carte des dettes se tait.
      const carnet = dettes.error ? [] : ((dettes.data ?? []) as { total_due: number }[]);
      setError('');
      setToday({
        revenue: Number(ligne?.revenue ?? 0),
        cash: Number(ligne?.cash ?? 0),
        momo: Number(ligne?.momo ?? 0),
        sales: Number(ligne?.tx ?? 0),
        debtTotal: carnet.reduce((s, d) => s + Number(d.total_due), 0),
        debtClients: carnet.length,
      });
    })();
    return () => { annule = true; };
  }, [actif, user, supabase]);

  return { today, todayError: error };
}
