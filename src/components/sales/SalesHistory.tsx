'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, CreditCard, Handshake, Smartphone, RefreshCw, Receipt, FileSpreadsheet, FileText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { PeriodPicker } from '@/components/ui/PeriodPicker';
import { formatCFA, formatQty } from '@/lib/utils/currency';
import { imprimerRapport } from '@/lib/utils/rapport';
import { toCSV, downloadCSV } from '@/lib/utils/export';
import { isFeatureAllowed, PLAN_LIMITS, PLAN_LABELS } from '@/lib/utils/plans';
import { addDays, localTimeZone, rangeFromDays, todayISO, toISODate, type DateRange } from '@/lib/utils/period';
import type { Sale, SaleItem } from '@/types';

interface SaleWithItems extends Sale {
  sale_items: SaleItem[];
}

const PAGE_SIZE = 20;

export function SalesHistory() {
  const { supabase, plan, org } = useSupabase();
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  // Compte de la période, demandé au serveur en même temps que la page. Il ne
  // se déduit plus de sales.length, qui ne vaut désormais que le lot courant.
  const [totalRows, setTotalRows] = useState(0);
  // Total de la période, agrégé en base puisqu'aucun agrégat PostgREST n'est
  // autorisé (PGRST123) : additionné ici, il exigerait toutes les ventes.
  const [totalPeriode, setTotalPeriode] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<DateRange>(() => rangeFromDays(7));
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState('');

  // Numéro de la dernière requête lancée. Un changement rapide de période ou de
  // page peut faire arriver une réponse ANCIENNE après une plus récente : sans
  // ce garde, le lot périmé écrasait l'état affiché.
  const requestIdRef = useRef(0);

  // Bornes appliquées à la fois au filtre choisi et au plafond du plan : une
  // période demandée au-delà de salesHistoryDays est ramenée dans les limites.
  const bornes = (f: DateRange) => {
    // Bornes incluses des deux côtés : sans le .lte, la journée du jour même
    // disparaissait et l'écran affichait « aucune vente » après un encaissement.
    const from = new Date(`${f.from}T00:00:00`);
    const to = new Date(`${f.to}T23:59:59.999`);

    const planDays = PLAN_LIMITS[plan].salesHistoryDays;
    const floor = planDays === Infinity
      ? null
      : new Date(`${addDays(todayISO(), -(planDays - 1))}T00:00:00`);

    return { from: floor && floor > from ? floor : from, to };
  };

  const fetchSales = async (f: DateRange, page: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const { from, to } = bornes(f);

      // Deux requêtes en parallèle, et surtout aucune qui grandit avec la
      // période : la première ne renvoie que le lot de 20 (plus son compte
      // total, fourni par PostgREST), la seconde un total de période agrégé
      // en base. Avant, les deux additionnaient dans le navigateur toutes les
      // ventes de la période — 30 jours en free, illimités en pro.
      const [pageRes, sumRes] = await Promise.all([
        supabase
          .from('sales')
          .select('*, sale_items(*)', { count: 'exact' })
          .gte('created_at', from.toISOString())
          .lte('created_at', to.toISOString())
          .order('created_at', { ascending: false })
          .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
        supabase.rpc('get_sales_summary', {
          p_from: toISODate(from),
          p_to: toISODate(to),
          p_tz: localTimeZone(),
        }),
      ]);

      // L'error était ignorée : un échec de réseau s'affichait comme
      // « Aucune vente sur cette période ».
      if (pageRes.error) throw new Error(pageRes.error.message);
      if (sumRes.error) throw new Error(sumRes.error.message);

      // Réponse d'une requête plus ancienne : ignorée.
      if (requestId !== requestIdRef.current) return;

      const jours = (sumRes.data ?? []) as { revenue: number }[];
      setTotalPeriode(jours.reduce((n, d) => n + Number(d.revenue), 0));
      setTotalRows(pageRes.count ?? 0);
      setSales((pageRes.data as SaleWithItems[]) ?? []);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError((e as Error).message);
      setSales([]);
      setTotalRows(0);
      setTotalPeriode(0);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  // La requête dépend du filtre ET du plan : l'ancien `[]` ne refetchait pas
  // si le plan changeait (upgrade/downgrade en cours de session).
  //
  // Deux effets plutôt qu'un seul, pour ne jamais fetcher deux fois : le
  // premier couvre tout ce qui doit revenir à la page 1 (filtre ou plan
  // changé), le second ne se déclenche que sur un vrai changement de page.
  useEffect(() => {
    setCurrentPage(1);
    fetchSales(filter, 1);
  }, [filter, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (currentPage === 1) return; // déjà couvert par l'effet ci-dessus
    fetchSales(filter, currentPage);
  }, [currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFilterChange = (f: DateRange) => setFilter(f);

  // Le sélecteur est plafonné par le plan, donc une période tronquée ne peut
  // venir que d'un changement de plan en cours de session.
  const planDays = PLAN_LIMITS[plan].salesHistoryDays;
  const isTruncatedByPlan = planDays !== Infinity;

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  // L'export part de TOUTE la période, pas de la page affichée. La liste est
  // désormais paginée en base : exporter les seules 20 lignes visibles au nom
  // de la période entière serait un export tronqué en silence, pire que pas
  // d'export du tout. Un export complet demande par définition toutes les
  // lignes — c'est l'utilisateur qui le déclenche, une fois.
  /** Toutes les ventes de la période (pas seulement la page affichée). */
  const ventesDeLaPeriode = async () => {
    const { from, to } = bornes(filter);
    const { data, error: exportErr } = await supabase
      .from('sales')
      .select('*, sale_items(*)')
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString())
      .order('created_at', { ascending: false });
    if (exportErr) throw new Error(exportErr.message);
    const ventes = (data as SaleWithItems[]) ?? [];
    return { from, to, ventes };
  };

  const libellePaiement = (s: SaleWithItems) =>
    s.payment_method === 'momo' ? 'MoMo'
      : s.payment_method === 'credit' ? (s.settled ? 'Crédit soldé' : 'Crédit')
      : 'Espèces';
  const articles = (s: SaleWithItems) =>
    s.sale_items.map((i) => `${formatQty(Number(i.quantity))} x ${i.product_name}`).join(' | ');

  const exporter = async (format: 'excel' | 'pdf') => {
    setExporting(true);
    setError('');
    try {
      const { from, to, ventes } = await ventesDeLaPeriode();
      if (format === 'excel') {
        const csv = toCSV(
          ventes.map((s) => ({
            date: new Date(s.created_at).toLocaleString('fr-FR'),
            montant: s.total_amount,
            encaisse: s.amount_received,
            paiement: libellePaiement(s),
            client: s.client_name ?? '',
            articles: articles(s),
          })),
          [
            { key: 'date',     label: 'Date' },
            { key: 'montant',  label: 'Montant (F)' },
            { key: 'encaisse', label: 'Encaissé (F)' },
            { key: 'paiement', label: 'Paiement' },
            { key: 'client',   label: 'Client' },
            { key: 'articles', label: 'Articles' },
          ],
          // Séparateur d'Excel en français : avec ',' tout tenait dans une colonne.
          ';',
        );
        downloadCSV(csv, `ventes-${filter.from}-au-${filter.to}.csv`);
      } else {
        const jour = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        const ok = imprimerRapport({
          titre: 'Ventes',
          boutique: org?.name ?? '',
          periode: toISODate(from) === toISODate(to) ? `le ${jour(from)}` : `du ${jour(from)} au ${jour(to)}`,
          colonnes: [
            { label: 'Date', insecable: true }, { label: 'Articles' }, { label: 'Paiement' },
            { label: 'Montant', droite: true }, { label: 'Encaissé', droite: true },
          ],
          lignes: ventes.map((s) => [
            new Date(s.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
            articles(s), libellePaiement(s),
            formatCFA(Number(s.total_amount)), formatCFA(Number(s.amount_received)),
          ]),
          total: [
            `${ventes.length} vente${ventes.length > 1 ? 's' : ''}`, '', '',
            formatCFA(ventes.reduce((t, s) => t + Number(s.total_amount), 0)),
            formatCFA(ventes.reduce((t, s) => t + Number(s.amount_received), 0)),
          ],
        });
        if (!ok) setError('Votre navigateur a bloqué la fenêtre du PDF : autorisez les fenêtres pour ce site, puis réessayez.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  return (
    <div className="space-y-4">
      {/* Filtres */}
      <PeriodPicker
        value={filter}
        onChange={handleFilterChange}
        maxDays={planDays}
        className="bg-slate-100 rounded-xl p-1.5"
      />

      {isTruncatedByPlan && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Le plan {PLAN_LABELS[plan]} donne accès à {PLAN_LIMITS[plan].salesHistoryDays} jours
          d&apos;historique. Les ventes plus anciennes ne sont pas affichées.
        </p>
      )}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Impossible de charger les ventes : {error}
        </p>
      )}

      {/* Résumé */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="border-indigo-100 bg-indigo-50">
          <CardContent className="p-4">
            <div className="text-xs text-indigo-500 font-medium mb-1">Total période</div>
            <div className="text-xl font-bold text-indigo-700">{formatCFA(totalPeriode)}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-xs text-slate-500 font-medium mb-1">Transactions</div>
            <div className="text-xl font-bold text-slate-800">{totalRows}</div>
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => fetchSales(filter, currentPage)}
          disabled={loading}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
        {totalRows > 0 && (isFeatureAllowed(plan, 'exportCsv') ? (
          <>
            <Button variant="outline" size="sm" onClick={() => exporter('excel')} disabled={exporting}
              className="gap-2 border-slate-200 h-10 sm:h-8">
              <FileSpreadsheet className="h-4 w-4" /> Excel
            </Button>
            <Button variant="outline" size="sm" onClick={() => exporter('pdf')} disabled={exporting}
              className="gap-2 border-slate-200 h-10 sm:h-8">
              <FileText className="h-4 w-4" /> PDF
            </Button>
          </>
        ) : (
          <span className="text-xs text-slate-500">Export Excel et PDF : plan Starter</span>
        ))}
      </div>

      {/* Liste des ventes */}
      {totalRows === 0 && !loading && !error ? (
        <EmptyState
          icon={Receipt}
          title="Aucune vente sur cette période"
          hint="Élargissez la période ci-dessus, ou enregistrez une vente depuis l’onglet Vente."
        />
      ) : sales.length > 0 ? (
        <div className="space-y-2">
          {sales.map((sale) => {
            const isOpen = expanded === sale.id;
            return (
              <Card key={sale.id} className="border-slate-200 overflow-hidden">
                <button className="w-full text-left" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : sale.id)}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                      sale.payment_method === 'momo' ? 'bg-emerald-100 text-emerald-700'
                      : sale.payment_method === 'credit' ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-600'
                    }`}>
                      {sale.payment_method === 'momo' ? <Smartphone className="h-4 w-4" />
                        : sale.payment_method === 'credit' ? <Handshake className="h-4 w-4" />
                        : <CreditCard className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800">{formatCFA(sale.total_amount)}</span>
                        <Badge className={`text-xs ${
                          sale.payment_method === 'momo'
                            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
                            : sale.payment_method === 'credit'
                              ? 'bg-amber-100 text-amber-700 hover:bg-amber-100'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-100'
                        }`}>
                          {/* Une vente à crédit ne doit JAMAIS s'afficher « Espèces » :
                              c'est faux, et c'est le genre d'écart qui fait
                              perdre confiance dans l'historique. « Crédit » et
                              « Crédit soldé » disent ce qui s'est réellement
                              passé. */}
                          {sale.payment_method === 'momo' ? 'MoMo'
                            : sale.payment_method === 'credit'
                              ? (sale.settled ? 'Crédit soldé' : 'Crédit')
                              : 'Espèces'}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {formatDate(sale.created_at)}, {sale.sale_items.length} article{sale.sale_items.length > 1 ? 's' : ''}
                        {/* Vente à crédit partiellement réglée : sans cette ligne,
                            l'historique affiche 130 000 F alors que la caisse n'a
                            reçu qu'une partie. C'est le genre d'écart qui fait
                            douter de l'application entière. */}
                        {sale.payment_method === 'credit'
                          && Number(sale.amount_received ?? 0) > 0
                          && Number(sale.amount_received) < Number(sale.total_amount) && (
                          <span className="text-amber-700">
                            {' '}, {formatCFA(sale.amount_received)} reçus, {formatCFA(Number(sale.total_amount) - Number(sale.amount_received))} dus
                          </span>
                        )}
                      </div>
                    </div>
                    {isOpen ? <ChevronUp className="h-4 w-4 text-slate-500 shrink-0" /> : <ChevronDown className="h-4 w-4 text-slate-500 shrink-0" />}
                  </CardContent>
                </button>
                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-1">
                    {sale.sale_items.map((item) => (
                      <div key={item.id} className="flex justify-between text-sm">
                        <span className="text-slate-600">{item.product_name} <span className="text-slate-500">x{item.quantity}</span></span>
                        <span className="font-medium text-slate-800">{formatCFA(item.subtotal)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between text-sm font-bold pt-2 border-t border-slate-200 mt-2">
                      <span>Total</span>
                      <span className="text-indigo-600">{formatCFA(sale.total_amount)}</span>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : null}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            aria-label="Page précédente"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            ←
          </button>
          <span className="text-sm text-slate-500">{currentPage} / {totalPages}</span>
          <button
            aria-label="Page suivante"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
