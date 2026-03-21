'use client';

import { useState, useEffect } from 'react';
import { X, Save, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Product } from '@/types';

interface ProductFormProps {
  product?: Product | null; // null = ajout, Product = édition
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORIES = ['smartphones', 'informatique', 'accessoires', 'bureautique', 'reconditionnes', 'autre'];

export function ProductForm({ product, onClose, onSaved }: ProductFormProps) {
  const { supabase } = useSupabase();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: '',
    sku: '',
    category: '',
    price_buy: '',
    price_sell: '',
    stock_qty: '',
    min_stock_level: '5',
  });

  useEffect(() => {
    if (product) {
      setForm({
        name: product.name,
        sku: product.sku ?? '',
        category: product.category ?? '',
        price_buy: String(product.price_buy),
        price_sell: String(product.price_sell),
        stock_qty: String(product.stock_qty),
        min_stock_level: String(product.min_stock_level),
      });
    }
  }, [product]);

  const set = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!form.name || !form.price_sell) {
      setError('Le nom et le prix de vente sont obligatoires.');
      return;
    }

    setLoading(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const payload = {
      name: form.name.trim(),
      sku: form.sku.trim() || null,
      category: form.category || null,
      price_buy: parseFloat(form.price_buy) || 0,
      price_sell: parseFloat(form.price_sell) || 0,
      stock_qty: parseInt(form.stock_qty) || 0,
      min_stock_level: parseInt(form.min_stock_level) || 5,
    };

    let err;
    if (product) {
      ({ error: err } = await supabase.from('products').update(payload).eq('id', product.id));
    } else {
      ({ error: err } = await supabase.from('products').insert({ ...payload, user_id: user.id }));
    }

    setLoading(false);
    if (err) { setError(err.message); return; }
    onSaved();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h2 className="font-bold text-slate-800">
            {product ? 'Modifier le produit' : 'Nouveau produit'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Formulaire */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Nom */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Nom du produit *</label>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Ex: Samsung Galaxy A05"
              required
            />
          </div>

          {/* SKU */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">SKU / Code-barres</label>
            <Input
              value={form.sku}
              onChange={(e) => set('sku', e.target.value)}
              placeholder="Ex: SM-A055F"
              className="font-mono"
            />
          </div>

          {/* Catégorie */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-700">Catégorie</label>
            <select
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            >
              <option value="">— Choisir —</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
          </div>

          {/* Prix */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Prix achat (F)</label>
              <Input
                type="number"
                value={form.price_buy}
                onChange={(e) => set('price_buy', e.target.value)}
                placeholder="0"
                min="0"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Prix vente (F) *</label>
              <Input
                type="number"
                value={form.price_sell}
                onChange={(e) => set('price_sell', e.target.value)}
                placeholder="0"
                min="0"
                required
              />
            </div>
          </div>

          {/* Stock */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Stock initial</label>
              <Input
                type="number"
                value={form.stock_qty}
                onChange={(e) => set('stock_qty', e.target.value)}
                placeholder="0"
                min="0"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">Stock min. alerte</label>
              <Input
                type="number"
                value={form.min_stock_level}
                onChange={(e) => set('min_stock_level', e.target.value)}
                placeholder="5"
                min="0"
              />
            </div>
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold gap-2"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Enregistrement...</>
            ) : (
              <><Save className="h-4 w-4" /> {product ? 'Enregistrer' : 'Ajouter le produit'}</>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
