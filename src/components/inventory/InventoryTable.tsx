'use client';

import { useState, useMemo } from 'react';
import { AlertTriangle, Search, ArrowUpDown, Pencil, Trash2, Plus, PackagePlus, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatCFA } from '@/lib/utils/currency';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { toCSV, downloadCSV } from '@/lib/utils/export';
import { isFeatureAllowed } from '@/lib/utils/plans';
import type { Product } from '@/types';

interface InventoryTableProps {
  products: Product[];
  onEdit: (product: Product) => void;
  onRestock: (product: Product) => void;
  onAdd: () => void;
  onRefresh: () => void;
}

type SortKey = 'name' | 'stock_qty' | 'price_sell' | 'category';
type SortDir = 'asc' | 'desc';

export function InventoryTable({ products, onEdit, onRestock, onAdd, onRefresh }: InventoryTableProps) {
  const { supabase, plan } = useSupabase();

  const handleExport = () => {
    const csv = toCSV(products as unknown as Record<string, unknown>[], [
      { key: 'name', label: 'Produit' },
      { key: 'sku', label: 'SKU' },
      { key: 'category', label: 'Catégorie' },
      { key: 'price_buy', label: 'Prix achat (F)' },
      { key: 'price_sell', label: 'Prix vente (F)' },
      { key: 'stock_qty', label: 'Stock' },
      { key: 'min_stock_level', label: 'Stock min' },
    ]);
    downloadCSV(csv, `inventaire-${new Date().toISOString().slice(0, 10)}.csv`);
  };
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? '').toLowerCase().includes(q) ||
          (p.category ?? '').toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const va = a[sortKey] ?? '';
        const vb = b[sortKey] ?? '';
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
  }, [products, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset page quand la recherche change
  useMemo(() => { setCurrentPage(1); }, [search, sortKey, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (product: Product) => {
    if (!window.confirm(`Supprimer "${product.name}" ? Cette action est irréversible.`)) return;
    setDeletingId(product.id);
    await supabase.from('products').delete().eq('id', product.id);
    setDeletingId(null);
    onRefresh();
  };

  const lowStock = products.filter((p) => p.stock_qty < p.min_stock_level).length;

  return (
    <div className="space-y-4">
      {/* Alerte stock */}
      {lowStock > 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-red-700 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span><strong>{lowStock} produit{lowStock > 1 ? 's' : ''}</strong> en stock critique</span>
        </div>
      )}

      {/* Barre recherche + boutons */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Rechercher..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {isFeatureAllowed(plan, 'exportCsv') && (
          <Button onClick={handleExport} variant="outline" className="gap-2 shrink-0 border-slate-200">
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">CSV</span>
          </Button>
        )}
        <Button onClick={onAdd} className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Ajouter</span>
        </Button>
      </div>

      {/* Tableau */}
      <div className="rounded-lg border border-slate-200 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('name')}>
                <span className="flex items-center gap-1">Produit <ArrowUpDown className="h-3 w-3" /></span>
              </TableHead>
              <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('category')}>
                <span className="flex items-center gap-1">Catégorie <ArrowUpDown className="h-3 w-3" /></span>
              </TableHead>
              <TableHead className="cursor-pointer select-none text-right" onClick={() => toggleSort('price_sell')}>
                <span className="flex items-center justify-end gap-1">Prix <ArrowUpDown className="h-3 w-3" /></span>
              </TableHead>
              <TableHead className="cursor-pointer select-none text-right" onClick={() => toggleSort('stock_qty')}>
                <span className="flex items-center justify-end gap-1">Stock <ArrowUpDown className="h-3 w-3" /></span>
              </TableHead>
              <TableHead className="text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-400 py-10">
                  {products.length === 0 ? (
                    <div className="space-y-2">
                      <p>Aucun produit. Commencez par en ajouter un.</p>
                      <Button onClick={onAdd} variant="outline" size="sm" className="gap-1">
                        <Plus className="h-3 w-3" /> Ajouter un produit
                      </Button>
                    </div>
                  ) : 'Aucun produit trouvé'}
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((p) => {
                const isLow = p.stock_qty < p.min_stock_level;
                return (
                  <TableRow key={p.id} className="hover:bg-slate-50">
                    <TableCell>
                      <div className="font-medium text-slate-800">{p.name}</div>
                      {p.sku && <div className="text-xs text-slate-400 font-mono">{p.sku}</div>}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-slate-500">{p.category ?? '—'}</span>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-indigo-600">
                      {formatCFA(p.price_sell)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={isLow ? 'text-red-600 font-bold' : 'text-slate-700'}>
                        {p.stock_qty}
                      </span>
                      {isLow && (
                        <Badge variant="destructive" className="ml-2 text-xs py-0">!</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => onRestock(p)}
                          title="Réapprovisionner"
                          className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50"
                        >
                          <PackagePlus className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onEdit(p)}
                          title="Modifier"
                          className="p-1.5 rounded-lg text-indigo-600 hover:bg-indigo-50"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(p)}
                          disabled={deletingId === p.id}
                          title="Supprimer"
                          className="p-1.5 rounded-lg text-red-400 hover:bg-red-50 disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">
          {filtered.length} / {products.length} produit{products.length > 1 ? 's' : ''}
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-2 py-1 text-xs rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >
              ←
            </button>
            <span className="text-xs text-slate-500">{currentPage} / {totalPages}</span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-2 py-1 text-xs rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >
              →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
