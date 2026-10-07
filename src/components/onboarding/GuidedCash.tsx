'use client';

import { useRef, useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import { POSModule } from '@/components/pos/POSModule';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Product } from '@/types';

interface GuidedCashProps {
  products: Product[];
  /** Le stock vient de bouger : la liste des produits doit être relue. */
  onProductsChanged: () => void;
  /** Le patron passe l'étape : l'assistant est terminé, direction l'accueil. */
  onSkip: () => void;
}

/**
 * La caisse de l'onboarding : la vraie caisse, sans la navigation.
 *
 * C'est le même POSModule qu'au quotidien — apprendre une caisse « de démo »
 * pour en découvrir une autre ensuite serait apprendre deux fois. Seul le
 * cadre change : pas de menu, une consigne en haut, et une sortie discrète.
 *
 * La vente est réelle (stock décrémenté, chiffre d'affaires du jour) : le
 * patron vend un vrai article d'exemple, qu'il pourra retirer depuis le Stock.
 */
export function GuidedCash({ products, onProductsChanged, onSkip }: GuidedCashProps) {
  const { supabase, ownerId, refreshOrg } = useSupabase();
  const venteFaite = useRef(false);
  const [sortie, setSortie] = useState(false);

  const apresVente = async () => {
    venteFaite.current = true;
    onProductsChanged();
    if (!ownerId) return;
    // L'étape est écrite dès la vente, pas à la fermeture du reçu : si le
    // téléphone s'éteint reçu ouvert, la reprise affiche les félicitations
    // au lieu de redemander une première vente déjà faite.
    await supabase
      .from('organizations')
      .update({ onboarding_step: 'congrats' } as Record<string, unknown>)
      .eq('id', ownerId);
  };

  const apresRecu = async () => {
    if (venteFaite.current) await refreshOrg();
  };

  const passer = async () => {
    if (!ownerId || sortie) return;
    setSortie(true);
    await supabase
      .from('organizations')
      .update({ onboarding_done: true, onboarding_step: null } as Record<string, unknown>)
      .eq('id', ownerId);
    onSkip();
    await refreshOrg();
  };

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-indigo-100 bg-indigo-50/95 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-3">
          <ShoppingCart className="h-5 w-5 text-indigo-600 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-bold text-slate-800">Faites votre première vente</h1>
            <p className="text-xs text-slate-600">
              Cliquez sur un produit, puis sur «&nbsp;Encaisser&nbsp;». C&apos;est tout.
            </p>
          </div>
          <button
            type="button"
            onClick={passer}
            disabled={sortie}
            className="shrink-0 text-xs text-slate-500 hover:text-slate-700 underline disabled:opacity-50"
          >
            Plus tard
          </button>
        </div>
      </header>
      <main className="p-4">
        <POSModule products={products} onSaleComplete={apresVente} onReceiptClosed={apresRecu} />
      </main>
    </div>
  );
}
