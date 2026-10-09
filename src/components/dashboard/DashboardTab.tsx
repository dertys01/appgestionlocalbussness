'use client';

import { useMemo } from 'react';
import { Package, AlertTriangle, ShoppingCart, Wallet, Handshake, Receipt, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';
import type { Today } from '@/lib/hooks/useToday';
import type { Product } from '@/types';

interface DashboardTabProps {
  products: Product[];
  canManageProducts: boolean;
  onNewSale: () => void;
  onAddProduct: () => void;
  onRestock: (product: Product) => void;
  /** Chiffres du jour ; null pendant le chargement. */
  today?: Today | null;
  todayError?: string;
  onOpenDebts?: () => void;
}

/**
 * L'accueil : la journée en trois secondes.
 *
 * Trois questions, dans l'ordre où le commerçant se les pose : combien
 * ai-je encaissé, combien de ventes, qui me doit de l'argent. Le stock bas
 * n'apparaît que s'il y en a — une alerte toujours affichée n'alerte plus.
 *
 * La valeur du stock et le nombre de produits ont quitté les cartes : ce
 * sont des chiffres d'inventaire, pas de la journée. Ils restent en pied de
 * page, pour qui les cherche.
 */
export function DashboardTab({
  products, canManageProducts, onNewSale, onAddProduct, onRestock, today = null, todayError = '', onOpenDebts,
}: DashboardTabProps) {
  const totalProducts = products.length;
  const stockBas = useMemo(
    () => products.filter((p) => p.stock_qty < p.min_stock_level),
    [products]
  );
  const totalStockValue = useMemo(
    () => products.reduce((s, p) => s + p.price_sell * p.stock_qty, 0),
    [products]
  );
  const dateDuJour = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const chiffre = (v: string) => (today ? v : '…');

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Aujourd&apos;hui</h2>
        <p className="text-sm text-slate-500 first-letter:uppercase">{dateDuJour}</p>
      </div>

      <InstallPrompt />

      {totalProducts === 0 ? (
        /* Boutique neuve : les cartes afficheraient 0 partout — aucune
            information, et aucune indication de par où commencer. On les
            remplace par l'ordre des opérations ; elles réapparaissent dès le
            premier produit ajouté. */
        <Card className="border-indigo-200 bg-indigo-50">
          <CardContent className="p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-slate-800">
                {canManageProducts ? 'Bienvenue : vos trois premiers pas' : 'Boutique encore vide'}
              </h3>
              <p className="text-sm text-slate-600 mt-1">
                {canManageProducts
                  ? 'Rien n’est enregistré pour l’instant. Tout part de vos produits : le reste s’enchaîne.'
                  : 'Aucun produit n’est encore enregistré dans cette boutique. Le gérant doit en ajouter avant que vous puissiez encaisser.'}
              </p>
            </div>

            {canManageProducts && (
              <ol className="space-y-2 text-sm text-slate-700">
                {[
                  ['Ajoutez vos produits', 'nom, prix de vente et stock de départ'],
                  ['Enregistrez une vente', 'l’onglet Vente encaisse en quelques secondes'],
                  ['Suivez ce qui reste dû', 'dettes, rapports et prévisions se remplissent seuls'],
                ].map(([titre, detail], i) => (
                  <li key={titre} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
                      {i + 1}
                    </span>
                    <span>
                      <strong className="font-semibold">{titre}</strong>
                      <span className="text-slate-500"> : {detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {/* Le chiffre qui compte : ce qui est réellement rentré. */}
          <Card className="col-span-2 border-emerald-200 bg-emerald-50">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-emerald-800 text-sm mb-1">
                <Wallet className="h-4 w-4" /> Encaissé aujourd&apos;hui
              </div>
              <div className="text-3xl font-bold text-emerald-800 tabular-nums" aria-live="polite">
                {chiffre(formatCFA(today?.revenue ?? 0))}
              </div>
              {today && (today.cash > 0 || today.momo > 0) && (
                <p className="mt-1 text-xs text-emerald-800/80 tabular-nums">
                  Espèces {formatCFA(today.cash)} · Mobile Money {formatCFA(today.momo)}
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
                <Receipt className="h-4 w-4" /> Ventes
              </div>
              <div className="text-2xl font-bold text-slate-800 tabular-nums">
                {chiffre(String(today?.sales ?? 0))}
              </div>
            </CardContent>
          </Card>

          <Card className={today && today.debtTotal > 0 ? 'border-amber-200 bg-amber-50' : 'border-slate-200'}>
            <CardContent className="p-0">
              <button
                type="button"
                onClick={onOpenDebts}
                disabled={!onOpenDebts}
                className="w-full p-4 text-left disabled:cursor-default"
                aria-label={today ? `À recouvrer : ${formatCFA(today.debtTotal)}, voir les dettes` : 'À recouvrer'}
              >
                <span className={`flex items-center gap-2 text-sm mb-1 ${today && today.debtTotal > 0 ? 'text-amber-800' : 'text-slate-500'}`}>
                  <Handshake className="h-4 w-4" /> À recouvrer
                  {onOpenDebts && <ChevronRight className="h-4 w-4 ml-auto" />}
                </span>
                <span className={`block text-lg font-bold tabular-nums ${today && today.debtTotal > 0 ? 'text-amber-800' : 'text-slate-800'}`}>
                  {chiffre(formatCFA(today?.debtTotal ?? 0))}
                </span>
                {today && today.debtClients > 0 && (
                  <span className="block text-xs text-amber-800/80">
                    {today.debtClients} client{today.debtClients > 1 ? 's' : ''}
                  </span>
                )}
              </button>
            </CardContent>
          </Card>
        </div>
      )}

      {todayError && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Chiffres du jour indisponibles : {todayError}
        </p>
      )}

      <div className={`grid gap-3 ${canManageProducts ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <Button onClick={onNewSale} className="h-20 flex flex-col gap-1 bg-indigo-600 hover:bg-indigo-700 rounded-xl">
          <ShoppingCart className="h-6 w-6" />
          <span>Nouvelle vente</span>
        </Button>
        {canManageProducts && (
          <Button onClick={onAddProduct} variant="outline" className="h-20 flex flex-col gap-1 rounded-xl border-slate-200">
            <Package className="h-6 w-6 text-indigo-600" />
            <span>Ajouter produit</span>
          </Button>
        )}
      </div>

      {stockBas.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-red-600 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" /> Stock bas : {stockBas.length} produit{stockBas.length > 1 ? 's' : ''} à réapprovisionner
          </h3>
          {stockBas.map((p) => (
            <Card key={p.id} className="border-red-200 bg-red-50">
              <CardContent className="p-3 flex justify-between items-center gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-slate-800 text-sm truncate">{p.name}</div>
                  <div className="text-xs text-red-600">
                    Stock : {formatQty(p.stock_qty)} / min {formatQty(p.min_stock_level)}
                  </div>
                </div>
                {canManageProducts && (
                  <button
                    onClick={() => onRestock(p)}
                    className="shrink-0 text-xs bg-emerald-700 text-white px-3 py-2 rounded-lg font-medium hover:bg-emerald-800"
                  >
                    Réappro.
                  </button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {totalProducts > 0 && (
        <p className="text-xs text-slate-500 text-center">
          {totalProducts} produit{totalProducts > 1 ? 's' : ''} · valeur du stock {formatCFA(totalStockValue)}
        </p>
      )}
    </div>
  );
}
