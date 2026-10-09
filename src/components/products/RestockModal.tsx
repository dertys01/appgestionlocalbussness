'use client';

import { useState } from 'react';
import { X, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { logActivity } from '@/lib/utils/activity';
import { formatCFA } from '@/lib/utils/currency';
import type { Product } from '@/types';

interface RestockModalProps {
  product: Product;
  /** Quantité pré-remplie (prévisions) : le commerçant valide, il ne retape pas. */
  initialQty?: number;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * `stock_qty` est NUMERIC(12,3) depuis la migration « vente au poids » : un
 * produit vendu au kilo se réapprovisionne en 1,5, pas en 1. `parseInt`
 * tronquait, et renvoyait surtout NaN sur la virgule française — saisie
 * « 1,5 », le modal répondait « Quantité invalide » sans jamais le dire.
 */
const parseQty = (raw: string): number => {
  const n = Number(String(raw).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

export function RestockModal({ product, initialQty, onClose, onSaved }: RestockModalProps) {
  const { supabase, ownerId, actorName } = useSupabase();
  const [qty, setQty] = useState(initialQty !== undefined ? String(initialQty) : '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const added = parseQty(qty);
    if (!Number.isFinite(added) || added <= 0) { setError('Quantité invalide.'); return; }

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !ownerId) { setLoading(false); return; }

    // Incrément atomique côté serveur : `product.stock_qty` vient d'un props
    // potentiellement périmé, un read-modify-write client pouvait donc
    // écraser un réapprovisionnement concurrent. On relit la valeur réelle.
    const { data: fresh, error: readErr } = await supabase
      .from('products')
      .select('stock_qty')
      .eq('id', product.id)
      .single();
    if (readErr || !fresh) {
      setError(readErr?.message ?? 'Produit introuvable.');
      setLoading(false);
      return;
    }

    const stockBefore = fresh.stock_qty;
    const newQty = stockBefore + added;

    const { data: updated, error: err } = await supabase
      .from('products')
      .update({ stock_qty: newQty })
      .eq('id', product.id)
      .eq('stock_qty', stockBefore) // verrou optimiste : 0 ligne si concurrence
      .select('id');

    if (err) { setError(err.message); setLoading(false); return; }

    // Le verrou n'a pas été tenu : quelqu'un a modifié le stock entre la
    // lecture et l'écriture. supabase-js ne met PAS d'erreur quand 0 ligne ne
    // correspond pas — err reste null, et on continuait à écrire un stock_logs
    // décrivant un incrément qui n'a jamais eu lieu, puis à annoncer « succès ».
    if (!updated || updated.length === 0) {
      setError('Le stock a changé pendant la saisie. Vérifiez la nouvelle valeur et réessayez.');
      setLoading(false);
      return;
    }

    const { error: logErr } = await supabase.from('stock_logs').insert({
      user_id: ownerId,
      product_id: product.id,
      product_name: product.name,
      movement_type: 'restock',
      quantity_change: added,
      stock_before: stockBefore,
      stock_after: newQty,
    });
    if (logErr) { setError(logErr.message); setLoading(false); return; }

    await logActivity({
      ownerId,
      actorId: user.id,
      actorEmail: user.email ?? '',
      actorName,
      action: 'restock',
      description: `Réappro. ${product.name} : +${added} ${product.unit} (stock ${stockBefore} → ${newQty})`,
    });

    setLoading(false);
    onSaved();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="font-bold text-slate-800">Réapprovisionner</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-600" aria-label="Fermer">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="font-semibold text-slate-800">{product.name}</div>
            <div className="text-slate-500">
              Stock actuel : <strong>{product.stock_qty}</strong> {product.unit},{' '}
              {formatCFA(product.price_sell)}
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="restock-qty" className="text-sm font-medium text-slate-700">
              Quantité à ajouter ({product.unit})
            </label>
            <Input
              id="restock-qty"
              type="number"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder={product.unit === 'pce' ? 'Ex: 10' : 'Ex: 1,5'}
              // step="any" sinon le navigateur REFUSE une décimale (step par
              // défaut vaut 1) et bloque l'envoi avec un message générique.
              step="any"
              min="0.001"
              required
              autoFocus
            />
          </div>

          {parseQty(qty) > 0 && (
            <div className="text-sm text-emerald-700 font-medium">
              Nouveau stock : {product.stock_qty + parseQty(qty)} {product.unit}
              <span className="block text-xs text-slate-500 font-normal">
                (calculé sur le stock affiché, il sera revérifié à l&apos;enregistrement)
              </span>
            </div>
          )}

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-emerald-700 hover:bg-emerald-800 font-semibold gap-2"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Enregistrement...</>
            ) : (
              <><Plus className="h-4 w-4" /> Ajouter au stock</>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
