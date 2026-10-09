'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { TrendingUp, ShoppingCart, CreditCard, Smartphone, RefreshCw, BarChart3 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PeriodPicker } from '@/components/ui/PeriodPicker';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { PLAN_LIMITS } from '@/lib/utils/plans';
import {
  buildBuckets, bucketFor, bucketKey, daysBetween, localTimeZone, rangeFromDays,
  type DateRange,
} from '@/lib/utils/period';
import type { Plan } from '@/types';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

/** Une ligne journalière renvoyée par get_sales_summary(). */
interface SummaryDay {
  day: string;
  revenue: number;
  cash: number;
  momo: number;
  tx: number;
}

export function ReportsModule() {
  const { supabase, plan } = useSupabase();
  // Le plan borne l'historique : un compte Free ne peut pas demander un an,
  // même si le sélecteur le propose. La limite est déjà appliquée côté
  // SalesHistory ; elle doit l'être partout.
  const maxDays = PLAN_LIMITS[plan as Plan].salesHistoryDays;
  const [summary, setSummary] = useState<SummaryDay[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; qty: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<DateRange>(() => rangeFromDays(7));
  const [error, setError] = useState('');

  const fetchSales = async () => {
    setLoading(true);
    setError('');

    try {
      // Plus une seule ligne de vente téléchargée : la synthèse se calcule en
      // base, sur des colonnes déjà agrégées, et non dans le navigateur.
      // Deux appels en parallèle — totaux journaliers d'un côté, top de l'autre.
      //
      // Le fuseau du navigateur part avec la requête : c'est lui qui découpe
      // les journées, et le graphique doit garder exactement les mêmes barres
      // qu'avant la bascule.
      const tz = localTimeZone();
      const [syn, topRes] = await Promise.all([
        supabase.rpc('get_sales_summary', { p_from: period.from, p_to: period.to, p_tz: tz }),
        supabase.rpc('get_top_products', { p_from: period.from, p_to: period.to, p_tz: tz, p_limit: 6 }),
      ]);

      // L'error était ignorée : un échec de réseau affichait des rapports vides
      // sans aucun message.
      if (syn.error) throw new Error(syn.error.message);
      if (topRes.error) throw new Error(topRes.error.message);

      setSummary((syn.data as SummaryDay[]) ?? []);
      setTopProducts(
        ((topRes.data ?? []) as { product_name: string; qty: number }[])
          .map((r) => ({ name: r.product_name, qty: Number(r.qty) }))
      );
    } catch (e) {
      setError((e as Error).message);
      setSummary([]);
      setTopProducts([]);
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
  // journalières sont illisibles sur un téléphone.
  //
  // La base a déjà réduit les ventes à une ligne par jour — il ne reste qu'à
  // les replacer dans le bon seau, avec la même bucketKey() qu'avant. Les jours
  // sans vente ne reviennent pas de la base, mais buildBuckets() les complète.
  const salesByDay = useMemo(() => {
    const span = daysBetween(period.from, period.to);
    const bucket = bucketFor(span);
    const totals = new Map<string, number>();
    for (const d of summary) {
      const key = bucketKey(d.day, bucket);
      totals.set(key, (totals.get(key) ?? 0) + Number(d.revenue));
    }
    return buildBuckets(period, bucket, (key) => totals.get(key) ?? 0)
      .map((p) => ({ date: p.label, total: p.value }));
  }, [summary, period]);

  const { totalRevenu, cashTotal, momoTotal } = useMemo(() => {
    let revenue = 0;
    let cash = 0;
    let momo = 0;
    for (const d of summary) {
      revenue += Number(d.revenue);
      // Les deux parts sortent déjà séparées de la base, et non d'un `if`
      // reconstitué ici : les crédits (payment_method = 'credit') entrent dans
      // le chiffre d'affaires sans entrer ni dans cash ni dans momo. Un client
      // qui doit 50 000 F ne gonfle donc plus la part Mobile Money d'autant —
      // c'était le sens du correctif précédent, conservé tel quel en SQL.
      cash += Number(d.cash);
      momo += Number(d.momo);
    }
    return { totalRevenu: revenue, cashTotal: cash, momoTotal: momo };
  }, [summary]);

  const totalTransactions = useMemo(
    () => summary.reduce((n, d) => n + Number(d.tx), 0),
    [summary]
  );
  const moyenneParVente = totalTransactions > 0 ? totalRevenu / totalTransactions : 0;

  const paymentData = useMemo(
    () =>
      [
        { name: 'Espèces', value: cashTotal },
        { name: 'Mobile Money', value: momoTotal },
      ].filter((d) => d.value > 0),
    [cashTotal, momoTotal]
  );

  /**
   * Ce que les deux modes de paiement ne couvrent pas.
   *
   * Les règlements de dettes d'avant la base de caisse ne sont pas ventilés par
   * moyen : leur argent est bien dans le chiffre d'affaires, mais pas dans
   * « Espèces » ni « Mobile Money ». L'écart est donc visible — un commerçant
   * qui additionne les deux parts et retrouve moins que le total doit savoir
   * pourquoi, sinon il cherche le bug chez lui pendant des semaines.
   *
   * Le dire vaut mieux que l'arrondir en silence : ces versements se
   * ventilent d'eux-mêmes à la prochaine saisie.
   */
  const nonVentile = Math.max(0, totalRevenu - cashTotal - momoTotal);

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
          aria-label="Actualiser"
          onClick={fetchSales}
          disabled={loading}
          className="p-2 text-slate-500 hover:text-indigo-600 disabled:opacity-40 shrink-0"
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
            <div className="text-lg font-bold text-emerald-700">{formatCFA(momoTotal)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Graphique ventes par jour */}
      <Card className="border-slate-200">
        <CardContent className="p-4">
          <h3 className="font-semibold text-slate-700 mb-4">Ventes par jour</h3>
          {salesByDay.every((d) => d.total === 0) ? (
            <EmptyState
              icon={BarChart3}
              title="Aucune vente sur cette période"
              hint="Aucun chiffre à tracer : la période choisie ne contient aucune vente."
              className="py-6"
            />
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
              <div className="text-center text-slate-500 py-6 text-sm">Aucune donnée</div>
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
                            // Le premier produit est le plus vendu : sa barre
                            // fait 100 %. Sans le garde, un `qty` à 0 (ou
                            // absent) produisait NaN/Infinity et faisait
                            // disparaître toute la barre.
                            width: `${topProducts[0]?.qty ? (p.qty / topProducts[0].qty) * 100 : 0}%`,
                            backgroundColor: COLORS[i % COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                    {/* formatQty : « 19.5 unités » sortait avec un point, à côté
                        du stock écrit « 19,5 pce ». Et « 1 unités » : le
                        pluriel était collé à la quantité sans regarder. */}
                    <span className="text-sm font-bold text-slate-600 shrink-0">
                      {formatQty(p.qty)} {p.qty > 1 ? 'unités' : 'unité'}
                    </span>
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
              <div className="text-center text-slate-500 py-6 text-sm">Aucune donnée</div>
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
                <div className="text-center text-xs text-slate-500 mt-1">
                  Panier moyen : <strong>{formatCFA(moyenneParVente)}</strong>
                </div>
                {nonVentile > 0 && (
                  <p className="text-[11px] text-slate-400 text-center mt-1">
                    {formatCFA(nonVentile)} de règlements de dettes anciens ne sont
                    pas encore ventilés par moyen : ils sont dans le chiffre
                    d&apos;affaires, pas dans les deux parts ci-dessus.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
