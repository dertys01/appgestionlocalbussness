'use client';

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, CreditCard, Smartphone, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import type { Sale, SaleItem } from '@/types';

interface SaleWithItems extends Sale {
  sale_items: SaleItem[];
}

export function SalesHistory() {
  const { supabase } = useSupabase();
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchSales = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('sales')
      .select('*, sale_items(*)')
      .order('created_at', { ascending: false })
      .limit(50);
    setSales((data as SaleWithItems[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { fetchSales(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const totalJour = sales
    .filter((s) => {
      const today = new Date().toDateString();
      return new Date(s.created_at).toDateString() === today;
    })
    .reduce((sum, s) => sum + s.total_amount, 0);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="space-y-4">
      {/* Résumé du jour */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="border-indigo-100 bg-indigo-50">
          <CardContent className="p-4">
            <div className="text-xs text-indigo-500 font-medium mb-1">Ventes aujourd&apos;hui</div>
            <div className="text-xl font-bold text-indigo-700">{formatCFA(totalJour)}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="text-xs text-slate-500 font-medium mb-1">Transactions (50 der.)</div>
            <div className="text-xl font-bold text-slate-800">{sales.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Bouton rafraîchir */}
      <button
        onClick={fetchSales}
        disabled={loading}
        className="flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-600 disabled:opacity-40"
      >
        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        Actualiser
      </button>

      {/* Liste des ventes */}
      {sales.length === 0 && !loading ? (
        <div className="text-center text-slate-400 py-12 text-sm">
          Aucune vente enregistrée
        </div>
      ) : (
        <div className="space-y-2">
          {sales.map((sale) => {
            const isOpen = expanded === sale.id;
            return (
              <Card key={sale.id} className="border-slate-200 overflow-hidden">
                <button
                  className="w-full text-left"
                  onClick={() => setExpanded(isOpen ? null : sale.id)}
                >
                  <CardContent className="p-4 flex items-center gap-3">
                    {/* Icône paiement */}
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                      sale.payment_method === 'momo'
                        ? 'bg-emerald-100 text-emerald-600'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                      {sale.payment_method === 'momo'
                        ? <Smartphone className="h-4 w-4" />
                        : <CreditCard className="h-4 w-4" />}
                    </div>

                    {/* Infos */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800">
                          {formatCFA(sale.total_amount)}
                        </span>
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

                    {/* Chevron */}
                    {isOpen
                      ? <ChevronUp className="h-4 w-4 text-slate-400 shrink-0" />
                      : <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />}
                  </CardContent>
                </button>

                {/* Détail articles */}
                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 space-y-1">
                    {sale.sale_items.map((item) => (
                      <div key={item.id} className="flex justify-between text-sm">
                        <span className="text-slate-600">
                          {item.product_name} <span className="text-slate-400">x{item.quantity}</span>
                        </span>
                        <span className="font-medium text-slate-800">
                          {formatCFA(item.subtotal)}
                        </span>
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
    </div>
  );
}
