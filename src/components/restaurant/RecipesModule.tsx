'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChefHat, Loader2, Plus, Trash2, AlertTriangle } from 'lucide-react';

import { useSupabase } from '@/components/providers/SupabaseProvider';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCFA } from '@/lib/utils/currency';
import { lireMontant } from '@/lib/utils/nombres';

/**
 * Les recettes : ce qu'un plat coûte vraiment.
 *
 * Un patron n'achète pas du « poulet braisé », il achète du poulet, du riz et
 * de l'huile. Sans cette table, sa marge est une fiction. Avec elle, le coût
 * d'une portion est la somme de ses ingrédients — récursivement, donc un plat
 * peut contenir un autre plat.
 *
 * L'écriture passe par add_recipe_ingredient(), pas par un INSERT direct : la
 * fonction refuse une recette circulaire, ce qu'une contrainte SQL ne peut pas
 * voir. Le coût affiché vient de la base (product_cost), jamais d'un calcul ici.
 */

interface IngredientRow {
  ingredient_id: string;
  quantity: number;
  name: string;
  unit: string | null;
  stock_qty: number;
  price_buy: number | null;
}

interface RecetteRow {
  id: string;
  name: string;
  category: string | null;
  price_sell: number;
  stock_qty: number;
  unit_cost: number;
  margin: number;
  margin_pct: number | null;
  ingredient_count: number;
}

export function RecipesModule() {
  const { supabase, canManageProducts } = useSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = supabase as any;

  const [plats, setPlats] = useState<RecetteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [lignes, setLignes] = useState<IngredientRow[]>([]);
  const [catalogue, setCatalogue] = useState<Array<{ id: string; name: string }>>([]);
  const [ajout, setAjout] = useState('');
  const [qte, setQte] = useState('1');
  const [busy, setBusy] = useState(false);

  const charger = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await client
      .from('recipe_costs')
      .select('id, name, category, price_sell, stock_qty, unit_cost, margin, margin_pct, ingredient_count')
      .order('name');
    setLoading(false);
    if (err) { setError(err.message); return; }
    setPlats((data ?? []) as RecetteRow[]);
  }, [client]);

  const chargerLignes = useCallback(async (platId: string) => {
    const { data, error: err } = await client
      .from('recipe_ingredients')
      .select('ingredient_id, quantity, ingredient:products(name, unit, stock_qty, price_buy)')
      .eq('dish_id', platId);
    if (err) { setError(err.message); return; }
    setLignes(
      ((data ?? []) as Array<{ ingredient_id: string; quantity: number; ingredient: Omit<IngredientRow, 'ingredient_id' | 'quantity'> | null }>)
        .map((l) => ({
          ingredient_id: l.ingredient_id,
          quantity: Number(l.quantity),
          name: l.ingredient?.name ?? 'Ingrédient',
          unit: l.ingredient?.unit ?? 'pce',
          stock_qty: Number(l.ingredient?.stock_qty ?? 0),
          price_buy: l.ingredient?.price_buy != null ? Number(l.ingredient.price_buy) : null,
        }))
    );
  }, [client]);

  useEffect(() => {
    const t = setTimeout(() => { void charger(); }, 0);
    return () => clearTimeout(t);
  }, [charger]);

  useEffect(() => {
    const t = setTimeout(async () => {
      const { data } = await client.from('products').select('id, name').order('name');
      setCatalogue((data ?? []) as Array<{ id: string; name: string }>);
    }, 0);
    return () => clearTimeout(t);
  }, [client]);

  // Changer de plat vide les lignes dans le setTimeout, pas dans le corps de
  // l'effet : un setState synchrone ici provoque un rendu en cascade
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    const id = sel;
    const t = setTimeout(() => {
      if (!id) setLignes([]);
      else void chargerLignes(id);
    }, 0);
    return () => clearTimeout(t);
  }, [sel, chargerLignes]);

  const plat = plats.find((p) => p.id === sel) ?? null;

  // Le stock d'ingrédient qui manquerait pour UNE portion : c'est le vrai
  // signal d'un patron, bien avant que la vente ne refuse le plat.
  const ruptures = useMemo(
    () => lignes.filter((l) => l.stock_qty < l.quantity),
    [lignes]
  );

  const ajouter = async () => {
    if (!sel || !ajout) return;
    const n = lireMontant(qte) ?? 0;
    if (n <= 0) { setError('Quantité invalide.'); return; }
    setBusy(true);
    setError('');
    const { error: err } = await client.rpc('add_recipe_ingredient', {
      p_dish_id: sel,
      p_ingredient_id: ajout,
      p_quantity: n,
    });
    setBusy(false);
    if (err) { setError(err.message); return; }
    setAjout('');
    setQte('1');
    await Promise.all([chargerLignes(sel), charger()]);
  };

  const retirer = async (ingredientId: string) => {
    if (!sel) return;
    setBusy(true);
    setError('');
    const { error: err } = await client
      .from('recipe_ingredients')
      .delete()
      .eq('dish_id', sel)
      .eq('ingredient_id', ingredientId);
    setBusy(false);
    if (err) { setError(err.message); return; }
    await Promise.all([chargerLignes(sel), charger()]);
  };

  const avecRecette = plats.filter((p) => p.ingredient_count > 0);
  const sansRecette = plats.filter((p) => p.ingredient_count === 0);

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {/* Choix du plat */}
      {plats.length === 0 && !loading ? (
        <EmptyState
          icon={ChefHat}
          title="Aucun plat à composer"
          hint="Créez d'abord vos plats et vos ingrédients depuis l'onglet Stock : un ingrédient est un produit vendu ou non, mais qui a un stock."
        />
      ) : (
        <Card className="border-slate-200">
          <CardContent className="p-4 space-y-3">
            <label htmlFor="recipe-dish" className="text-sm font-medium text-slate-700">
              Plat à composer
            </label>
            <select
              id="recipe-dish"
              value={sel ?? ''}
              onChange={(e) => setSel(e.target.value || null)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">— Choisir un plat —</option>
              {[...avecRecette, ...sansRecette].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.ingredient_count > 0 ? ` (${p.ingredient_count} ingrédients)` : ' — sans recette'}
                </option>
              ))}
            </select>

            {plat && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
                  <p className="text-xs text-slate-500">Prix</p>
                  <p className="font-semibold text-slate-800 text-sm">{formatCFA(plat.price_sell)}</p>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-2">
                  <p className="text-xs text-slate-500">Coût portion</p>
                  <p className="font-semibold text-slate-800 text-sm">
                    {plat.ingredient_count > 0 ? formatCFA(plat.unit_cost) : '—'}
                  </p>
                </div>
                <div
                  className={`rounded-lg border p-2 ${
                    plat.margin_pct !== null && plat.margin_pct < 50
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-emerald-50 border-emerald-200'
                  }`}
                >
                  <p className="text-xs text-slate-500">Marge</p>
                  <p className="font-semibold text-slate-800 text-sm">
                    {plat.ingredient_count > 0 && plat.margin_pct !== null
                      ? `${plat.margin_pct} %`
                      : '—'}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ingrédients */}
      {plat && (
        <Card className="border-slate-200">
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">
              Ce qu&apos;il faut pour une portion de {plat.name}
            </h3>

            {lignes.length === 0 ? (
              <p className="text-sm text-slate-500 py-2 text-center">
                Aucun ingrédient. Sans recette, le coût affiché reste le prix
                d&apos;achat du plat.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {lignes.map((l) => {
                  const manque = l.stock_qty < l.quantity;
                  return (
                    <div key={l.ingredient_id} className="flex items-center gap-2 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-800 truncate">{l.name}</div>
                        <div className="text-xs text-slate-500">
                          {l.quantity} {l.unit} pour 1 portion · stock{' '}
                          {Number(l.stock_qty.toFixed(3))} {l.unit}
                        </div>
                      </div>
                      {manque && (
                        <span className="flex items-center gap-1 text-[11px] text-amber-700">
                          <AlertTriangle className="h-3 w-3" /> pas assez
                        </span>
                      )}
                      {canManageProducts && (
                        <button
                          onClick={() => retirer(l.ingredient_id)}
                          disabled={busy}
                          aria-label={`Retirer ${l.name} de la recette`}
                          className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-50 shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {ruptures.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {ruptures.length} ingrédient{ruptures.length > 1 ? 's ne suffisent' : ' ne suffit'} pas
                pour une portion : la vente de ce plat sera refusée tant que le
                stock n&apos;est pas réapprovisionné.
              </p>
            )}

            {canManageProducts && (
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="Ingrédient à ajouter"
                  value={ajout}
                  onChange={(e) => setAjout(e.target.value)}
                  className="flex-1 min-w-40 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">— Ingrédient —</option>
                  {catalogue
                    .filter((c) => c.id !== sel)
                    .map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
                <Input
                  value={qte}
                  onChange={(e) => setQte(e.target.value)}
                  aria-label="Quantité pour une portion"
                  placeholder="Qté"
                  className="w-24"
                />
                <Button
                  onClick={ajouter}
                  disabled={busy || !ajout}
                  className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Ajouter
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}