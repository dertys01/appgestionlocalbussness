'use client';

import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { TrendingUp, ShoppingCart, CreditCard, Smartphone, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import type { Sale, SaleItem } from '@/types';

interface SaleWithItems extends Sale {
  sale_items: SaleItem[];
}

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export function ReportsModule() {
  const { supabase } = useSupabase();
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<7 | 30>(7);

  const fetchSales = async () => {
    setLoading(true);
    const since = new Date();
    since.setDate(since.getDate() - period);

    const { data } = await supabase
      .from('sales')
      .select('*, sale_items(*)')
      .gte('created_at', since.toISOString())
      .order('created_at');

    setSales((data as SaleWithItems[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { fetchSales(); }, [period]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ventes par jour ──
  const salesByDay = (() => {
    const map: Record<string, number> = {};
    for (let i = period - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      map[key] = 0;
    }
    sales.forEach((s) => {
      const key = new Date(s.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      if (key in map) map[key] += s.total_amount;
    });
    return Object.entries(map).map(([date, total]) => ({ date, total }));
  })();

  // ── Top produits ──
  const topProducts = (() => {
    const map: Record<string, number> = {};
    sales.forEach((s) =>
      s.sale_items.forEach((i) => {
        map[i.product_name] = (map[i.product_name] ?? 0) + i.quantity;
      })
    );
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, qty]) => ({ name, qty }));
  })();

  // ── Répartition paiement ──
  const paymentData = (() => {
    const cash = sales.filter((s) => s.payment_method === 'cash').reduce((s, v) => s + v.total_amount, 0);
    const momo = sales.filter((s) => s.payment_method === 'momo').reduce((s, v) => s + v.total_amount, 0);
    return [
      { name: 'Espèces', value: cash },
      { name: 'Mobile Money', value: momo },
    ].filter((d) => d.value > 0);
  })();

  // ── Stats globales ──
  const totalRevenu = sales.reduce((s, v) => s + v.total_amount, 0);
  const totalTransactions = sales.length;
  const moyenneParVente = totalTransactions > 0 ? totalRevenu / totalTransactions : 0;
  const cashTotal = sales.filter((s) => s.payment_method === 'cash').reduce((s, v) => s + v.total_amount, 0);
  const momoTotal = sales.filter((s) => s.payment_method === 'momo').reduce((s, v) => s + v.total_amount, 0);

  return (
    <div className="space-y-5">
      {/* Sélecteur période + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {([7, 30] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                period === p
                  ? 'bg-indigo-600 text-white'
                  : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              {p} jours
            </button>
          ))}
        </div>
        <button
          onClick={fetchSales}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-indigo-600 disabled:opacity-40"
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
