'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ShoppingCart,
  Plus,
  Minus,
  Trash2,
  CreditCard,
  Smartphone,
  Search,
  Share2,
  X,
  Printer,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCFA } from '@/lib/utils/currency';
import { generateWhatsAppReceiptLink } from '@/lib/utils/whatsapp';
import { logActivity } from '@/lib/utils/activity';
import { printReceipt } from '@/lib/utils/print';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Product, CartItem } from '@/types';

interface POSModuleProps {
  products: Product[];
  onSaleComplete?: () => void;
  /**
   * Produit à ajouter au panier (issu du scanner de la page parente).
   * Le panier vit dans ce composant : sans cette prop, un scan depuis la
   * barre latérale changeait d'onglet mais ne remplissait rien.
   */
  addToCartRequest?: { productId: string; token: number } | null;
}

type PaymentMethod = 'cash' | 'momo';

/**
 * Nombre de cartes produits rendues d'un coup. 60 tient sur deux écrans de
 * téléphone en colonne double, soit environ 2 000 nœuds DOM pour la grille —
 * au-delà, le défilement saccade sur un appareil d'entrée de gamme.
 */
const PRODUCT_PAGE_SIZE = 60;

interface ReceiptState {
  saleId: string;
  /** Numéro de facture calculé par le serveur (Pro uniquement). */
  invoiceNumber: string | null;
  waLink: string;
  items: CartItem[];
  total: number;
  paymentMethod: PaymentMethod;
  clientName: string;
  clientPhone: string;
  amountGiven: number;
  change: number;
  date: Date;
}

/**
 * Les exceptions de `create_sale` (supabase/migration_sales_rpc.sql) sont
 * rédigées pour être affichables telles quelles à la caissière. Les autres
 * messages (réseau, PostgREST) ne le sont pas.
 */
function readableSaleError(message: string): string {
  if (/^(Stock insuffisant|Produit introuvable|Panier vide|Moyen de paiement invalide)/.test(message)) {
    return message;
  }
  if (message === 'Non authentifié') return 'Session expirée, reconnectez-vous.';
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return "Connexion impossible. Vérifiez votre réseau et réessayez — la vente n'a pas été enregistrée.";
  }
  return "La vente n'a pas été enregistrée. Aucune modification n'a été appliquée.";
}

export function POSModule({ products, onSaleComplete, addToCartRequest }: POSModuleProps) {
  const { supabase, ownerId, actorName, org } = useSupabase();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [scanError, setScanError] = useState('');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PRODUCT_PAGE_SIZE);
  // Une recherche remet la tranche au début : sans cela, taper « Nokia » après
  // avoir déroulé 400 produits affiche une grille vide alors qu'il y en a 3.
  const [lastSearch, setLastSearch] = useState('');
  if (search !== lastSearch) {
    setLastSearch(search);
    setVisibleCount(PRODUCT_PAGE_SIZE);
  }
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [amountGiven, setAmountGiven] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);

  // Recherche produits avec debounce minimal (useMemo suffit pour ce cas)
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products.filter(
      (p) =>
        p.stock_qty > 0 &&
        p.is_active !== false && // archivé : hors caisse
        (p.name.toLowerCase().includes(q) ||
          (p.sku ?? '').toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q))
    );
  }, [products, search]);

  // Rendu par tranches. La recherche porte sur tout le catalogue : une caissière
  // qui tape « Nokia » doit le trouver même si la carte est à la position 800.
  const visibleProducts = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount]
  );

  const total = useMemo(
    () => cart.reduce((sum, item) => sum + item.product.price_sell * item.quantity, 0),
    [cart]
  );

  const addToCart = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock_qty) return prev;
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  }, []);

  // Demande d'ajout venue du scanner (page parente). Le `token` permet de
  // re-scanner deux fois le même SKU : comparer la seule valeur de productId
  // ferait ignorer le second scan.
  useEffect(() => {
    if (!addToCartRequest) return;
    const product = products.find((p) => p.id === addToCartRequest.productId);
    if (!product) {
      setScanError('Produit introuvable.');
      return;
    }
    if (product.stock_qty <= 0) {
      setScanError(`« ${product.name} » est en rupture de stock.`);
      return;
    }
    setScanError('');
    addToCart(product);
  }, [addToCartRequest, products, addToCart]);

  const updateQty = useCallback((productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((i) =>
          i.product.id === productId ? { ...i, quantity: i.quantity + delta } : i
        )
        .filter((i) => i.quantity > 0)
    );
  }, []);

  const removeFromCart = useCallback((productId: string) => {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }, []);

  const handleCheckout = async () => {
    if (cart.length === 0 || loading) return;
    setLoading(true);
    setCheckoutError('');

    try {
      // Toute l'écriture passe par une unique fonction SQL atomique : vente,
      // lignes, décrément de stock et journal — ou rien du tout.
      // Voir supabase/migration_sales_rpc.sql.
      // Seul product_id et quantity sont envoyés : le prix, le total et le
      // numéro de facture sont recalculés côté serveur.
      const { data, error: saleErr } = await supabase.rpc('create_sale', {
        p_items: cart.map((i) => ({
          product_id: i.product.id,
          quantity: i.quantity,
        })),
        p_payment_method: paymentMethod,
        p_client_name: clientName.trim() || null,
      });

      if (saleErr) throw new Error(readableSaleError(saleErr.message));
      if (!data || typeof data !== 'object') throw new Error("La vente n'a pas pu être enregistrée.");

      // Total et numéro de facture sont ceux retenus par le serveur.
      const saleId = String(data.id);
      const serverTotal = Number(data.total_amount ?? total);
      const invoiceNumber = (data.invoice_number as string | null) ?? null;

      // Journal d'activité : best-effort, ne doit pas faire échouer l'encaissement
      const { data: { user } } = await supabase.auth.getUser();
      if (user && ownerId) {
        const itemsDesc = cart.map((i) => `${i.quantity}x ${i.product.name}`).join(', ');
        await logActivity({
          ownerId,
          actorId: user.id,
          actorEmail: user.email ?? '',
          actorName,
          action: 'sale',
          description: `Vente ${formatCFA(serverTotal)} (${paymentMethod === 'cash' ? 'Espèces' : 'MoMo'}) — ${itemsDesc}`,
          metadata: { sale_id: saleId, total: serverTotal, payment_method: paymentMethod },
        });
      }

      // Lien WhatsApp. businessName et phone n'étaient jamais transmis : tous
      // les reçus disaient « Notre Boutique » et s'ouvraient sans destinataire.
      const waLink = generateWhatsAppReceiptLink(
        {
          items: cart.map((i) => ({
            product_name: i.product.name,
            quantity: i.quantity,
            unit_price: i.product.price_sell,
            subtotal: i.product.price_sell * i.quantity,
          })),
          total: serverTotal,
          paymentMethod,
          date: new Date(),
          businessName: org?.name,
        },
        clientPhone.trim() || undefined
      );

      const given = parseFloat(amountGiven) || 0;
      setReceipt({
        saleId,
        invoiceNumber,
        waLink,
        items: [...cart],
        total: serverTotal,
        paymentMethod,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        amountGiven: given,
        change: paymentMethod === 'cash' && given >= serverTotal ? given - serverTotal : 0,
        date: new Date(),
      });
      setCart([]);
      setClientName('');
      setClientPhone('');
      setAmountGiven('');
      onSaleComplete?.();
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full">
      {/* ── Grille produits ── */}
      <div className="flex-1 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Rechercher un produit..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Le compteur évite qu'un commerçant cherche un produit absent en
            croyant qu'il n'existe pas : avec 1 000 références, une grille
            tronquée sans indication paraît vide. */}
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>
            {filtered.length} produit{filtered.length > 1 ? 's' : ''}
            {search.trim() && ` pour « ${search.trim()} »`}
          </span>
          {visibleProducts.length < filtered.length && (
            <span>affichage par tranches</span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {visibleProducts.map((p) => {
            const inCart = cart.find((i) => i.product.id === p.id);
            return (
              <button
                key={p.id}
                onClick={() => addToCart(p)}
                className="group relative text-left rounded-xl border border-slate-200 bg-white p-3 shadow-sm hover:border-indigo-400 hover:shadow-md transition-all active:scale-95"
              >
                {inCart && (
                  <span className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center font-bold">
                    {inCart.quantity}
                  </span>
                )}
                <div className="text-xs text-slate-400 mb-1">{p.category ?? '—'}</div>
                <div className="font-semibold text-slate-800 text-sm leading-tight line-clamp-2">
                  {p.name}
                </div>
                <div className="mt-2 font-bold text-indigo-600">{formatCFA(p.price_sell)}</div>
                <div className="text-xs text-slate-400">Stock : {p.stock_qty}</div>
              </button>
            );
          })}

          {filtered.length === 0 && (
            <div className="col-span-full text-center text-slate-400 py-12">
              {search.trim() ? 'Aucun produit ne correspond à cette recherche' : 'Aucun produit disponible'}
            </div>
          )}
        </div>

        {/* Pagination par tranches plutôt que rendu de 1 000 cartes : le DOM
            devient inutilisable sur un téléphone, et une caissière doit
            trouver un produit en deux secondes. La recherche porte toujours
            sur le catalogue entier, pas sur la tranche affichée. */}
        {visibleProducts.length < filtered.length && (
          <button
            onClick={() => setVisibleCount((n) => n + PRODUCT_PAGE_SIZE)}
            className="w-full py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
          >
            Afficher plus de produits
            <span className="text-slate-400 font-normal">
              {' '}({visibleProducts.length} / {filtered.length})
            </span>
          </button>
        )}
      </div>

      {/* ── Panier ── */}
      <div className="lg:w-80 flex flex-col gap-3">
        <div className="flex items-center gap-2 font-semibold text-slate-700">
          <ShoppingCart className="h-5 w-5 text-indigo-600" />
          Panier
          {cart.length > 0 && (
            <Badge className="ml-auto bg-indigo-600">{cart.length}</Badge>
          )}
        </div>

        {/* Articles */}
        <div className="flex-1 space-y-2 max-h-[45vh] overflow-y-auto pr-1">
          {cart.length === 0 ? (
            <div className="text-center text-slate-400 py-10 text-sm">
              Cliquez sur un produit pour l&apos;ajouter
            </div>
          ) : (
            cart.map((item) => (
              <Card key={item.product.id} className="shadow-none border-slate-200">
                <CardContent className="p-3 flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">
                      {item.product.name}
                    </div>
                    <div className="text-xs text-indigo-600 font-semibold">
                      {formatCFA(item.product.price_sell * item.quantity)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => updateQty(item.product.id, -1)}
                      className="h-6 w-6 rounded-full border border-slate-200 flex items-center justify-center hover:bg-slate-100"
                    >
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="text-sm font-bold w-5 text-center">{item.quantity}</span>
                    <button
                      onClick={() => updateQty(item.product.id, 1)}
                      disabled={item.quantity >= item.product.stock_qty}
                      className="h-6 w-6 rounded-full border border-slate-200 flex items-center justify-center hover:bg-slate-100 disabled:opacity-40"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => removeFromCart(item.product.id)}
                      className="ml-1 text-red-400 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {scanError && (
          <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
            {scanError}
          </p>
        )}

        {/* Nom + téléphone client (optionnel) */}
        <div className="border-t border-slate-200 pt-3 space-y-2">
          <Input
            placeholder="Nom du client (optionnel)"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className="text-sm"
          />
          <Input
            type="tel"
            inputMode="tel"
            placeholder="Téléphone WhatsApp (optionnel)"
            value={clientPhone}
            onChange={(e) => setClientPhone(e.target.value)}
            className="text-sm"
          />
        </div>

        {/* Total */}
        <div className="border-t border-slate-200 pt-3 space-y-3">
          <div className="flex justify-between text-lg font-bold text-slate-800">
            <span>Total</span>
            <span className="text-indigo-600">{formatCFA(total)}</span>
          </div>

          {/* Mode de paiement */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setPaymentMethod('cash')}
              className={`flex items-center justify-center gap-2 rounded-lg border py-2 text-sm font-medium transition-colors ${
                paymentMethod === 'cash'
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <CreditCard className="h-4 w-4" />
              Espèces
            </button>
            <button
              onClick={() => setPaymentMethod('momo')}
              className={`flex items-center justify-center gap-2 rounded-lg border py-2 text-sm font-medium transition-colors ${
                paymentMethod === 'momo'
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Smartphone className="h-4 w-4" />
              MoMo
            </button>
          </div>

          {/* Montant donné + monnaie (espèces uniquement) */}
          {paymentMethod === 'cash' && (
            <div className="space-y-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500">Montant donné (FCFA)</label>
                <Input
                  type="number"
                  placeholder={String(total)}
                  value={amountGiven}
                  onChange={(e) => setAmountGiven(e.target.value)}
                  min={0}
                  className="text-sm"
                />
              </div>
              {parseFloat(amountGiven) >= total && (
                <div className="flex justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                  <span className="text-sm font-medium text-emerald-700">Monnaie à rendre</span>
                  <span className="text-sm font-bold text-emerald-700">
                    {formatCFA(parseFloat(amountGiven) - total)}
                  </span>
                </div>
              )}
              {parseFloat(amountGiven) > 0 && parseFloat(amountGiven) < total && (
                <div className="flex justify-between rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                  <span className="text-sm font-medium text-red-600">Reste à payer</span>
                  <span className="text-sm font-bold text-red-600">
                    {formatCFA(total - parseFloat(amountGiven))}
                  </span>
                </div>
              )}
            </div>
          )}

          {checkoutError && (
            <p className="text-red-500 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              {checkoutError}
            </p>
          )}
          <Button
            onClick={handleCheckout}
            disabled={cart.length === 0 || loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl"
          >
            {loading ? 'Enregistrement...' : `Encaisser ${formatCFA(total)}`}
          </Button>
        </div>
      </div>

      {/* ── Modal reçu ── */}
      <Dialog open={!!receipt} onOpenChange={() => setReceipt(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-600">
              ✅ Vente enregistrée !
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-slate-600 text-sm text-center">
              La vente a été enregistrée avec succès.
            </p>
            <div className="flex flex-col gap-2">
              {/* WhatsApp */}
              <a
                href={receipt?.waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl bg-[#25D366] text-white font-semibold py-3 hover:bg-[#1ebe5d] transition-colors"
              >
                <Share2 className="h-4 w-4" />
                {receipt?.clientPhone ? 'Envoyer le reçu WhatsApp' : 'Partager le reçu WhatsApp'}
              </a>
              {!receipt?.clientPhone && (
                <p className="text-xs text-slate-400 text-center -mt-1">
                  Renseignez un téléphone ci-dessus pour envoyer directement au client.
                </p>
              )}

              {/* Reçu simple — tous les plans */}
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => {
                  if (!receipt || !org) return;
                  printReceipt({ ...receipt, org });
                }}
              >
                <Printer className="h-4 w-4" />
                Imprimer le reçu
              </Button>

              {/* Facture normalisée — Pro uniquement.
                  Le numéro est attribué par create_sale au moment de l'encaissement
                  (incrément atomique côté serveur), il n'est plus recalculé ici. */}
              {receipt?.invoiceNumber ? (
                <Button
                  variant="outline"
                  className="w-full gap-2 border-amber-300 text-amber-700 hover:bg-amber-50"
                  onClick={() => {
                    if (!receipt || !org) return;
                    printReceipt({ ...receipt, org });
                  }}
                >
                  <FileText className="h-4 w-4" />
                  Facture normalisée
                </Button>
              ) : (
                <button
                  className="text-xs text-slate-400 flex items-center justify-center gap-1"
                  onClick={() => setReceipt(null)}
                >
                  <FileText className="h-3 w-3" />
                  Facture normalisée — Plan Pro uniquement
                </button>
              )}

              <Button variant="ghost" onClick={() => setReceipt(null)} className="w-full gap-2 text-slate-500">
                <X className="h-4 w-4" />
                Fermer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
