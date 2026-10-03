import { useEffect, useState } from 'react';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Product } from '@/types';

/**
 * Catalogue de la boutique : l'état, le premier chargement et le rechargement
 * manuel.
 *
 * Les deux chemins coexistent volontairement et ne doivent pas être fusionnés :
 * l'effet fait le premier affichage, `fetchProducts` répond au bouton
 * « Actualiser », à une vente validée, à un produit enregistré, à un
 * inventaire terminé. Les réunir ici évite que la page les recopie.
 *
 * `user` et `supabase` viennent du contexte : la page n'a donc pas à les
 * redescendre, et le hook se rattache tout seul au bon locataire.
 */
export function useProducts() {
  const { supabase, user } = useSupabase();
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productsError, setProductsError] = useState('');

  const fetchProducts = async () => {
    if (!user) return;
    setLoadingProducts(true);
    try {
      const { data, error } = await supabase.from('products').select('*').order('name');
      if (error) throw new Error(error.message);
      setProducts((data as Product[]) ?? []);
      // Sinon une erreur passée restait affichée après un rechargement réussi.
      setProductsError('');
    } catch (e) {
      setProductsError((e as Error).message);
    } finally {
      setLoadingProducts(false);
    }
  };

  // Le setState n'est plus synchrone dans le corps de l'effet : l'appel est
  // asynchrone et le lint react-hooks/set-state-in-effect est satisfait.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoadingProducts(true);
      const { data, error } = await supabase.from('products').select('*').order('name');
      if (cancelled) return;
      if (error) setProductsError(error.message);
      else {
        setProducts((data as Product[]) ?? []);
        setProductsError('');
      }
      setLoadingProducts(false);
    })();
    return () => { cancelled = true; };
  }, [user, supabase]);

  return { products, loadingProducts, productsError, fetchProducts };
}
