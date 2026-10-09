import { useCallback, useEffect, useRef, useState } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { useRealtimeRefresh } from '@/lib/hooks/useRealtimeRefresh';
import type { Product } from '@/types';

/**
 * Catalogue de la boutique : l'état, le premier chargement et le rechargement
 * manuel.
 *
 * Les deux chemins (le montage et `fetchProducts`) passent désormais par la
 * MÊME fonction : la requête n'est plus écrite deux fois, et les deux héritent
 * du garde d'ordre et de l'annulation au démontage. `fetchProducts` reste
 * exposé pour le bouton « Actualiser », une vente validée, un produit
 * enregistré, un inventaire terminé.
 *
 * `user` et `supabase` viennent du contexte : la page n'a donc pas à les
 * redescendre, et le hook se rattache tout seul au bon locataire.
 */
export function useProducts() {
  const { supabase, user } = useSupabase();
  const [products, setProducts] = useState<Product[]>([]);
  // Vrai DÈS le premier rendu : le catalogue n'est encore arrivé nulle part
  // (ni SSR ni hydratation ne l'ont). Partir à `false` affichait l'état
  // « boutique neuve » pendant une peinture — le flash vu en recette.
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productsError, setProductsError] = useState('');

  // Numéro de la dernière requête lancée : une réponse plus ancienne arrivée
  // après une plus récente est ignorée. Sans ce garde, le rafraîchissement
  // manuel et le rechargement post-vente pouvaient se croiser, et la réponse
  // la plus lente écrasait la plus récente.
  const requestIdRef = useRef(0);

  const fetchProducts = useCallback(async () => {
    // Sans utilisateur, rien à charger. On ne baisse PAS loadingProducts : il
    // reste `true` pour que la première peinture (juste avant que la session
    // soit résolue) ne montre pas l'état « boutique neuve » — c'est le flash
    // corrigé en recette.
    if (!user) return;

    const requestId = ++requestIdRef.current;
    setLoadingProducts(true);
    try {
      const { data, error } = await supabase.from('products').select('*').order('name');
      if (requestId !== requestIdRef.current) return;
      if (error) throw new Error(error.message);
      setProducts((data as Product[]) ?? []);
      // Sinon une erreur passée restait affichée après un rechargement réussi.
      setProductsError('');
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setProductsError((e as Error).message);
    } finally {
      if (requestId === requestIdRef.current) setLoadingProducts(false);
    }
  }, [supabase, user]);

  // Chargement initial, puis à chaque changement de locataire : on réutilise
  // fetchProducts (état, garde d'ordre et annulation au démontage) au lieu de
  // dupliquer la requête. Le cleanup invalide la requête en vol.
  useEffect(() => {
    void fetchProducts();
    return () => { requestIdRef.current += 1; };
  }, [fetchProducts]);

  // Temps réel (si NEXT_PUBLIC_REALTIME=1) : le catalogue d'un autre appareil
  // qui vient de vendre ou de réapprovisionner déclenche un rechargement.
  useRealtimeRefresh(['products'], fetchProducts);

  return { products, loadingProducts, productsError, fetchProducts };
}
