'use client';

import { useState, useMemo, useCallback } from 'react';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatCFA } from '@/lib/utils/currency';
import { generateWhatsAppReceiptLink } from '@/lib/utils/whatsapp';
import { logActivity } from '@/lib/utils/activity';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Product, CartItem } from '@/types';

interface POSModuleProps {
  products: Product[];
  onSaleComplete?: () => void;
}

type PaymentMethod = 'cash' | 'momo';

export function POSModule({ products, onSaleComplete }: POSModuleProps) {
  const { supabase, ownerId, actorName } = useSupabase();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [loading, setLoading] = useState(false);
  const [receipt, setReceipt] = useState<{ saleId: string; waLink: string } | null>(null);

  // Recherche produits avec debounce minimal (useMemo suffit pour ce cas)
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products.filter(
      (p) =>
        p.stock_qty > 0 &&
        (p.name.toLowerCase().includes(q) ||
          (p.sku ?? '').toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q))
    );
  }, [products, search]);

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

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !ownerId) throw new Error('Non authentifié');

      // 1. Créer la vente (user_id = ownerId pour isoler les données par business)
      const { data: sale, error: saleErr } = await supabase
        .from('sales')
        .insert({ user_id: ownerId, total_amount: total, payment_method: paymentMethod })
        .select()
        .single();

      if (saleErr) throw saleErr;

      // 2. Insérer les sale_items
      const items = cart.map((i) => ({
        sale_id: sale.id,
        product_id: i.product.id,
        product_name: i.product.name,
        quantity: i.quantity,
        unit_price: i.product.price_sell,
        subtotal: i.product.price_sell * i.quantity,
      }));

      const { error: itemsErr } = await supabase.from('sale_items').insert(items);
      if (itemsErr) throw itemsErr;

      // 3. Mise à jour du stock + stock_logs
      for (const item of cart) {
        const newQty = item.product.stock_qty - item.quantity;

        await supabase
          .from('products')
          .update({ stock_qty: newQty })
          .eq('id', item.product.id);

        await supabase.from('stock_logs').insert({
          user_id: ownerId,
          product_id: item.product.id,
          product_name: item.product.name,
          movement_type: 'sale',
          quantity_change: -item.quantity,
          stock_before: item.product.stock_qty,
          stock_after: newQty,
          reference_id: sale.id,
        });
      }

      // 4. Journal d'activité
      const itemsDesc = cart.map((i) => `${i.quantity}x ${i.product.name}`).join(', ');
      await logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName,
        action: 'sale',
        description: `Vente ${formatCFA(total)} (${paymentMethod === 'cash' ? 'Espèces' : 'MoMo'}) — ${itemsDesc}`,
        metadata: { sale_id: sale.id, total, payment_method: paymentMethod },
      });

      // 5. Générer le lien WhatsApp
      const waLink = generateWhatsAppReceiptLink({
        items: items.map((i) => ({
          product_name: i.product_name,
          quantity: i.quantity,
          unit_price: i.unit_price,
          subtotal: i.subtotal,
        })),
        total,
        paymentMethod,
        date: new Date(),
      });

      setReceipt({ saleId: sale.id, waLink });
      setCart([]);
      onSaleComplete?.();
    } catch (err) {
      alert('Erreur lors de la vente : ' + (err as Error).message);
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

        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((p) => {
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
              Aucun produit disponible
            </div>
          )}
        </div>
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
          <div className="space-y-4 py-2">
            <p className="text-slate-600 text-sm text-center">
              La vente a été enregistrée avec succès.
            </p>
            <div className="flex flex-col gap-2">
              <a
                href={receipt?.waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl bg-[#25D366] text-white font-semibold py-3 hover:bg-[#1ebe5d] transition-colors"
              >
                <Share2 className="h-4 w-4" />
                Partager le reçu WhatsApp
              </a>
              <Button
                variant="outline"
                onClick={() => setReceipt(null)}
                className="w-full gap-2"
              >
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
