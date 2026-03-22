'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingDown, CheckCircle, PackagePlus, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RestockModal } from '@/components/products/RestockModal';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import type { Product } from '@/types';

interface ProductForecast {
  product: Product;
  soldLast30Days: number;
  avgPerDay: number;
  daysUntilStockout: number | null; // null = pas de ventes récentes
  suggestedReorder: number;
}

const ANALYSIS_DAYS = 30;
const REORDER_HORIZON = 30; // vouloir avoir du stock pour 30 jours

export function ForecastModule({ onRestock }: { onRestock: () => void }) {
  const { supabase } = useSupabase();
  const [forecasts, setForecasts] = useState<ProductForecast[]>([]);
  const [loading, setLoading] = useState(false);
  const [restockProduct, setRestockProduct] = useState<Product | null>(null);

  const fetchForecasts = async () => {
    setLoading(true);

    const since = new Date();
    since.setDate(since.getDate() - ANALYSIS_DAYS);

    const [{ data: products }, { data: saleItems }] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase
        .from('sale_items')
        .select('product_id, quantity, sales(created_at)')
        .gte('sales.created_at', since.toISOString()),
    ]);

    if (!products) { setLoading(false); return; }

    // Calcule les quantités vendues par produit
    const soldMap: Record<string, number> = {};
    (saleItems ?? []).forEach((item) => {
      if (item.sales) {
        soldMap[item.product_id] = (soldMap[item.product_id] ?? 0) + item.quantity;
      }
    });

    const result: ProductForecast[] = (products as Product[]).map((p) => {
      const soldLast30Days = soldMap[p.id] ?? 0;
      const avgPerDay = soldLast30Days / ANALYSIS_DAYS;
      const daysUntilStockout =
        avgPerDay > 0 ? Math.floor(p.stock_qty / avgPerDay) : null;
      const suggestedReorder = Math.max(
        0,
        Math.ceil(avgPerDay * REORDER_HORIZON) - p.stock_qty
      );

      return { product: p, soldLast30Days, avgPerDay, daysUntilStockout, suggestedReorder };
    });

    // Trier par urgence : d'abord ceux qui vont manquer bientôt
    result.sort((a, b) => {
      if (a.daysUntilStockout === null && b.daysUntilStockout === null) return 0;
      if (a.daysUntilStockout === null) return 1;
      if (b.daysUntilStockout === null) return -1;
      return a.daysUntilStockout - b.daysUntilStockout;
    });

    setForecasts(result);
    setLoading(false);
  };

  useEffect(() => { fetchForecasts(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const urgent = forecasts.filter((f) => f.daysUntilStockout !== null && f.daysUntilStockout <= 7);
  const warning = forecasts.filter((f) => f.daysUntilStockout !== null && f.daysUntilStockout > 7 && f.daysUntilStockout <= 14);
  const ok = forecasts.filter((f) => f.daysUntilStockout === null || f.daysUntilStockout > 14);

  const getStatus = (f: ProductForecast) => {
    if (f.daysUntilStockout === null) return 'nodata';
    if (f.daysUntilStockout <= 7) return 'urgent';
    if (f.daysUntilStockout <= 14) return 'warning';
    return 'ok';
  };

  const statusConfig = {
    urgent: { color: 'border-red-200 bg-red-50', badge: 'bg-red-100 text-red-700 hover:bg-red-100', label: 'Urgent' },
    warning: { color: 'border-amber-200 bg-amber-50', badge: 'bg-amber-100 text-amber-700 hover:bg-amber-100', label: 'Attention' },
    ok: { color: 'border-emerald-200 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100', label: 'OK' },
    nodata: { color: 'border-slate-200', badge: 'bg-slate-100 text-slate-500 hover:bg-slate-100', label: 'Pas de données' },
  };

  return (
    <div className="space-y-4">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Basé sur les ventes des <strong>30 derniers jours</strong>
        </p>
        <button
          onClick={fetchForecasts}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Résumé */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-3 text-center">
            <AlertTriangle className="h-5 w-5 text-red-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-red-600">{urgent.length}</div>
            <div className="text-xs text-red-500">Rupture &lt; 7j</div>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-3 text-center">
            <TrendingDown className="h-5 w-5 text-amber-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-amber-600">{warning.length}</div>
            <div className="text-xs text-amber-500">Attention &lt; 14j</div>
          </CardContent>
        </Card>
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-3 text-center">
            <CheckCircle className="h-5 w-5 text-emerald-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-emerald-600">{ok.length}</div>
            <div className="text-xs text-emerald-500">Stock suffisant</div>
          </CardContent>
        </Card>
      </div>

      {/* Liste produits */}
      {loading ? (
        <div className="text-center text-slate-400 py-10 text-sm">Analyse en cours...</div>
      ) : forecasts.length === 0 ? (
        <div className="text-center text-slate-400 py-10 text-sm">Aucun produit</div>
      ) : (
        <div className="space-y-2">
          {forecasts.map((f) => {
            const status = getStatus(f);
            const cfg = statusConfig[status];

            return (
              <Card key={f.product.id} className={`border ${cfg.color}`}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-800 text-sm truncate">
                          {f.product.name}
                        </span>
                        <Badge className={`text-xs py-0 ${cfg.badge}`}>
                          {status === 'urgent' && `⚠️ Rupture dans ${f.daysUntilStockout}j`}
                          {status === 'warning' && `${f.daysUntilStockout}j restants`}
                          {status === 'ok' && f.daysUntilStockout !== null && `${f.daysUntilStockout}j restants`}
                          {status === 'nodata' && 'Aucune vente récente'}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-slate-500">
                        <div>
                          <span className="block text-slate-400">Stock actuel</span>
                          <span className="font-semibold text-slate-700">{f.product.stock_qty}</span>
                        </div>
                        <div>
                          <span className="block text-slate-400">Vendu / 30j</span>
                          <span className="font-semibold text-slate-700">{f.soldLast30Days}</span>
                        </div>
                        <div>
                          <span className="block text-slate-400">Moy. / jour</span>
                          <span className="font-semibold text-slate-700">
                            {f.avgPerDay > 0 ? f.avgPerDay.toFixed(1) : '—'}
                          </span>
                        </div>
                      </div>

                      {f.suggestedReorder > 0 && (
                        <div className="mt-2 text-xs text-indigo-600 font-medium">
                          💡 Commander ~{f.suggestedReorder} unités pour 30j ({formatCFA(f.suggestedReorder * f.product.price_buy)})
                        </div>
                      )}
                    </div>

                    {(status === 'urgent' || status === 'warning') && (
                      <button
                        onClick={() => setRestockProduct(f.product)}
                        className="shrink-0 p-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
                        title="Réapprovisionner"
                      >
                        <PackagePlus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {restockProduct && (
        <RestockModal
          product={restockProduct}
          onClose={() => setRestockProduct(null)}
          onSaved={() => { fetchForecasts(); onRestock(); }}
        />
      )}
    </div>
  );
}
