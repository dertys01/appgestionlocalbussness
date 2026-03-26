'use client';

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, CreditCard, Smartphone, RefreshCw, Download } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { toCSV, downloadCSV } from '@/lib/utils/export';
import { isFeatureAllowed } from '@/lib/utils/plans';
import type { Sale, SaleItem } from '@/types';

interface SaleWithItems extends Sale {
  sale_items: SaleItem[];
}

type DateFilter = 'today' | '7d' | '30d' | 'all';
const PAGE_SIZE = 20;

const FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'today', label: "Aujourd'hui" },
  { key: '7d',    label: '7 jours' },
  { key: '30d',   label: '30 jours' },
  { key: 'all',   label: 'Tout' },
];

function getStartDate(filter: DateFilter): string | null {
  const now = new Date();
  if (filter === 'today') {
    now.setHours(0, 0, 0, 0);
    return now.toISOString();
  }
  if (filter === '7d') {
    now.setDate(now.getDate() - 7);
    return now.toISOString();
  }
  if (filter === '30d') {
    now.setDate(now.getDate() - 30);
    return now.toISOString();
  }
  return null;
}

export function SalesHistory() {
  const { supabase, plan } = useSupabase();
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<DateFilter>('7d');
  const [currentPage, setCurrentPage] = useState(1);

  const fetchSales = async (f: DateFilter = filter) => {
    setLoading(true);
    let query = supabase
      .from('sales')
      .select('*, sale_items(*)')
      .order('created_at', { ascending: false });

    const start = getStartDate(f);
    if (start) query = query.gte('created_at', start);

    const { data } = await query;
    setSales((data as SaleWithItems[]) ?? []);
    setCurrentPage(1);
    setLoading(false);
  };

  useEffect(() => { fetchSales(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFilterChange = (f: DateFilter) => {
    setFilter(f);
    fetchSales(f);
  };

  const totalPeriode = sales.reduce((sum, s) => sum + s.total_amount, 0);
  const totalPages = Math.max(1, Math.ceil(sales.length / PAGE_SIZE));
  const paginated = sales.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  return (
    <div className="space-y-4">
      {/* Filtres */}
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleFilterChange(key)}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              filter === key ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

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
            <div className="text-xl font-bold text-slate-800">{sales.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => fetchSales()}
          disabled={loading}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </button>
        {isFeatureAllowed(plan, 'exportCsv') && sales.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const rows = sales.map((s) => ({
                date: new Date(s.created_at).toLocaleString('fr-FR'),
                montant: s.total_amount,
                paiement: s.payment_method === 'momo' ? 'MoMo' : 'Espèces',
                articles: s.sale_items.map((i) => `${i.quantity}x ${i.product_name}`).join(' | '),
              }));
              const csv = toCSV(rows, [
                { key: 'date',     label: 'Date' },
                { key: 'montant',  label: 'Montant (F)' },
                { key: 'paiement', label: 'Paiement' },
                { key: 'articles', label: 'Articles' },
              ]);
              downloadCSV(csv, `ventes-${new Date().toISOString().slice(0, 10)}.csv`);
            }}
            className="gap-2 border-slate-200"
          >
            <Download className="h-4 w-4" />
            CSV
          </Button>
        )}
      </div>

      {/* Liste des ventes */}
      {sales.length === 0 && !loading ? (
        <div className="text-center text-slate-400 py-12 text-sm">
          Aucune vente sur cette période
        </div>
      ) : (
        <div className="space-y-2">
          {paginated.map((sale) => {
            const isOpen = expanded === sale.id;
            return (
              <Card key={sale.id} className="border-slate-200 overflow-hidden">
                <button className="w-full text-left" onClick={() => setExpanded(isOpen ? null : sale.id)}>
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                      sale.payment_method === 'momo' ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {sale.payment_method === 'momo' ? <Smartphone className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800">{formatCFA(sale.total_amount)}</span>
                        <Badge className={`text-xs ${
                          sale.payment_method === 'momo'
                            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-100'
                        }`}>
                          {sale.payment_method === 'momo' ? 'MoMo' : 'Espèces'}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {formatDate(sale.created_at)} — {sale.sale_items.length} article{sale.sale_items.length > 1 ? 's' : ''}
                      </div>
                    </div>
                    {isOpen ? <ChevronUp className="h-4 w-4 text-slate-400 shrink-0" /> : <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />}
                  </CardContent>
                </button>
                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-1">
                    {sale.sale_items.map((item) => (
                      <div key={item.id} className="flex justify-between text-sm">
                        <span className="text-slate-600">{item.product_name} <span className="text-slate-400">x{item.quantity}</span></span>
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
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1 text-sm rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
          >
            ←
          </button>
          <span className="text-sm text-slate-500">{currentPage} / {totalPages}</span>
          <button
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
