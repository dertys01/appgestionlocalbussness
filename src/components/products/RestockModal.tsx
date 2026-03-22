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
  onClose: () => void;
  onSaved: () => void;
}

export function RestockModal({ product, onClose, onSaved }: RestockModalProps) {
  const { supabase, ownerId, actorName } = useSupabase();
  const [qty, setQty] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const added = parseInt(qty);
    if (!added || added <= 0) { setError('Quantité invalide.'); return; }

    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !ownerId) { setLoading(false); return; }

    const newQty = product.stock_qty + added;

    const { error: err } = await supabase
      .from('products')
      .update({ stock_qty: newQty })
      .eq('id', product.id);

    if (err) { setError(err.message); setLoading(false); return; }

    await supabase.from('stock_logs').insert({
      user_id: ownerId,
      product_id: product.id,
      product_name: product.name,
      movement_type: 'restock',
      quantity_change: added,
      stock_before: product.stock_qty,
      stock_after: newQty,
    });

    await logActivity({
      ownerId,
      actorId: user.id,
      actorEmail: user.email ?? '',
      actorName,
      action: 'restock',
      description: `Réappro. ${product.name} : +${added} unités (stock ${product.stock_qty} → ${newQty})`,
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
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="font-semibold text-slate-800">{product.name}</div>
            <div className="text-slate-500">
              Stock actuel : <strong>{product.stock_qty}</strong> unités —{' '}
              {formatCFA(product.price_sell)}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">
              Quantité à ajouter
            </label>
            <Input
              type="number"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Ex: 10"
              min="1"
              required
              autoFocus
            />
          </div>

          {qty && parseInt(qty) > 0 && (
            <div className="text-sm text-emerald-600 font-medium">
              Nouveau stock : {product.stock_qty + parseInt(qty)} unités
            </div>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-emerald-600 hover:bg-emerald-700 font-semibold gap-2"
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
