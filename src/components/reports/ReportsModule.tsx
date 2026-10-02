'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { TrendingUp, ShoppingCart, CreditCard, Smartphone, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PeriodPicker } from '@/components/ui/PeriodPicker';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { PLAN_LIMITS } from '@/lib/utils/plans';
import {
  buildBuckets, bucketFor, bucketKey, daysBetween, rangeFromDays, toISODate,
  type DateRange,
} from '@/lib/utils/period';
import type { Plan, Sale, SaleItem } from '@/types';

interface SaleWithItems extends Sale {
  sale_items: SaleItem[];
}

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export function ReportsModule() {
  const { supabase, plan } = useSupabase();
  // Le plan borne l'historique : un compte Free ne peut pas demander un an,
  // même si le sélecteur le propose. La limite est déjà appliquée côté
  // SalesHistory ; elle doit l'être partout.
  const maxDays = PLAN_LIMITS[plan as Plan].salesHistoryDays;
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<DateRange>(() => rangeFromDays(7));
  const [error, setError] = useState('');

  const fetchSales = async () => {
    setLoading(true);
    setError('');

    try {
      // Bornes locales converties en UTC : la période estinclusive des deux
      // journées, sinon la dernière est amputée du jour courant.
      const from = new Date(`${period.from}T00:00:00`);
      const to = new Date(`${period.to}T23:59:59.999`);

      const { data, error: queryErr } = await supabase
        .from('sales')
        .select('*, sale_items(*)')
        .gte('created_at', from.toISOString())
        .lte('created_at', to.toISOString())
        .order('created_at');

      // L'error était ignorée : un échec de réseau affichait des rapports vides
      // sans aucun message.
      if (queryErr) throw new Error(queryErr.message);
      setSales((data as SaleWithItems[]) ?? []);
    } catch (e) {
      setError((e as Error).message);
      setSales([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSales(); }, [period]); // eslint-disable-line react-hooks/exhaustive-deps

  // Les agrégats sont mémorisés : sans useMemo ils recalculaient sur chaque
  // rendu, y compris les resize/hover internes de recharts, en repassant
  // sur tout le tableau des ventes et des lignes de vente.
  //
  // Regroupement par jour, semaine ou mois selon l'amplitude : 365 barres
  // journalières sont illisibles sur un téléphone, et la requête elle-même
  // commence à coûter cher sur un an d'historique.
  const salesByDay = useMemo(() => {
    const span = daysBetween(period.from, period.to);
    const bucket = bucketFor(span);
    const totals = new Map<string, number>();
    for (const s of sales) {
      const key = bucketKey(toISODate(new Date(s.created_at)), bucket);
      totals.set(key, (totals.get(key) ?? 0) + s.total_amount);
    }
    return buildBuckets(period, bucket, (key) => totals.get(key) ?? 0)
      .map((p) => ({ date: p.label, total: p.value }));
  }, [sales, period]);

  const topProducts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of sales) {
      for (const i of s.sale_items) {
        map[i.product_name] = (map[i.product_name] ?? 0) + i.quantity;
      }
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, qty]) => ({ name, qty }));
  }, [sales]);

  const { totalRevenu, cashTotal, momoTotal } = useMemo(() => {
    let revenue = 0;
    let cash = 0;
    let momo = 0;
    for (const s of sales) {
      revenue += s.total_amount;
      // Trois cases et non deux : avec un simple `else`, les crédits
      // (payment_method = 'credit') atterrissaient dans « Mobile Money » — un
      // client qui doit 50 000 F gonflait la part Mobile Money d'autant.
      if (s.payment_method === 'cash') cash += s.total_amount;
      else if (s.payment_method === 'momo') momo += s.total_amount;
      // 'credit' : ni encaissé en espèces ni en Mobile Money. Il n'apparaît
      // que dans totalRevenu, et le camembert affiche des parts qui, elles,
      // s'additionnent bien au total encaissé.
    }
    return { totalRevenu: revenue, cashTotal: cash, momoTotal: momo };
  }, [sales]);

  const totalTransactions = sales.length;
  const moyenneParVente = totalTransactions > 0 ? totalRevenu / totalTransactions : 0;

  const paymentData = useMemo(
    () =>
      [
        { name: 'Espèces', value: cashTotal },
        { name: 'Mobile Money', value: momoTotal },
      ].filter((d) => d.value > 0),
    [cashTotal, momoTotal]
  );

  return (
    <div className="space-y-5">
      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Impossible de charger les rapports : {error}
        </p>
      )}

      {/* Sélecteur période + refresh */}
      <div className="flex items-start justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} maxDays={maxDays} />
        <button
          onClick={fetchSales}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-40 shrink-0"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Cartes stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <TrendingUp className="h-3.5 w-3.5" /> Chiffre d&apos;affaires
            </div>
            <div className="text-lg font-bold text-indigo-600">{formatCFA(totalRevenu)}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <ShoppingCart className="h-3.5 w-3.5" /> Transactions
            </div>
            <div className="text-lg font-bold text-slate-800">{totalTransactions}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <CreditCard className="h-3.5 w-3.5" /> Espèces
            </div>
            <div className="text-lg font-bold text-slate-800">{formatCFA(cashTotal)}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
              <Smartphone className="h-3.5 w-3.5" /> MoMo
            </div>
            <div className="text-lg font-bold text-emerald-600">{formatCFA(momoTotal)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Graphique ventes par jour */}
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <h3 className="font-semibold text-slate-700 mb-4">Ventes par jour</h3>
          {salesByDay.every((d) => d.total === 0) ? (
            <div className="text-center text-slate-400 py-8 text-sm">Aucune vente sur cette période</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={salesByDay} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  formatter={(value) => [formatCFA(Number(value)), 'Ventes']}
                  labelStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="total" fill="#6366f1" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* Top produits */}
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <h3 className="font-semibold text-slate-700 mb-4">Top produits vendus</h3>
            {topProducts.length === 0 ? (
              <div className="text-center text-slate-400 py-6 text-sm">Aucune donnée</div>
            ) : (
              <div className="space-y-2">
                {topProducts.map((p, i) => (
                  <div key={p.name} className="flex items-center gap-3">
                    <span
                      className="h-6 w-6 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                      style={{ backgroundColor: COLORS[i % COLORS.length] }}
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-700 truncate">{p.name}</div>
                      <div className="h-1.5 bg-slate-100 rounded-full mt-1">
                        <div
                          className="h-1.5 rounded-full"
                          style={{
                            width: `${(p.qty / topProducts[0].qty) * 100}%`,
                            backgroundColor: COLORS[i % COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                    <span className="text-sm font-bold text-slate-600 shrink-0">{p.qty} unités</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Répartition paiement */}
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <h3 className="font-semibold text-slate-700 mb-2">Modes de paiement</h3>
            {paymentData.length === 0 ? (
              <div className="text-center text-slate-400 py-6 text-sm">Aucune donnée</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie
                      data={paymentData}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={65}
                      dataKey="value"
                    >
                      {paymentData.map((_, i) => (
                        <Cell key={i} fill={i === 0 ? '#6366f1' : '#10b981'} />
                      ))}
                    </Pie>
                    <Legend formatter={(v) => <span className="text-xs">{v}</span>} />
                    <Tooltip formatter={(v) => formatCFA(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="text-center text-xs text-slate-400 mt-1">
                  Panier moyen : <strong>{formatCFA(moyenneParVente)}</strong>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
