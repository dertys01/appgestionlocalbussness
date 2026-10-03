'use client';

import { useState, useMemo } from 'react';
import { AlertTriangle, Search, ArrowUpDown, Pencil, Trash2, Plus, PackagePlus, Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
import { logActivity } from '@/lib/utils/activity';
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
  const { supabase, plan, canManageProducts, ownerId, actorName } = useSupabase();

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
  const [deleteError, setDeleteError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 20;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
    // Reset fait dans le gestionnaire d'événement plutôt que dans un effet :
    // évite un setState en cascade après le rendu.
    setCurrentPage(1);
  };

  const handleSearch = (value: string) => {
    setSearch(value);
    setCurrentPage(1);
  };;

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return products
      .filter(
        (p) =>
          p.is_active !== false && // archivé : masqué du catalogue
          (p.name.toLowerCase().includes(q) ||
            (p.sku ?? '').toLowerCase().includes(q) ||
            (p.category ?? '').toLowerCase().includes(q))
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
  // currentPage est dérivé, pas stocké : la recherche ou le tri change la
  // longueur de `filtered`, et une page devenue hors bornes produisait un
  // tableau vide sans message. Le clamp évite l'effet de resynchronisation.
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  /**
   * Archivage, pas suppression.
   * Le DELETE direct échouait sur tout produit ayant déjà été vendu (FK
   * sale_items / stock_logs sans ON DELETE CASCADE) et le message conseillait
   * « désactivez-le » alors qu'aucune colonne n'existait : chemin mort.
   * archive_product() refuse proprement si le produit a un historique de
   * ventes, et le journal d'activité trace l'opération.
   */
  const handleArchive = async (product: Product) => {
    if (!window.confirm(
      `Archiver "${product.name}" ?\n\n` +
      `Il disparaîtra de la caisse et de l'inventaire.\n` +
      `Si le produit a déjà été vendu, l'archivage sera refusé pour préserver l'historique.`
    )) return;

    setDeletingId(product.id);
    setDeleteError('');

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc('archive_product', { p_product_id: product.id });
      if (error) throw new Error(error.message);

      // Le journal était claimed mais jamais écrit sur suppression.
      const { data: { user } } = await supabase.auth.getUser();
      if (user && ownerId) {
        await logActivity({
          ownerId,
          actorId: user.id,
          actorEmail: user.email ?? '',
          actorName,
          action: 'product_archive',
          description: `Produit archivé : ${product.name}`,
          metadata: { product_id: product.id },
        });
      }
      onRefresh();
    } catch (e) {
      setDeleteError(readableArchiveError((e as Error).message, product.name));
    } finally {
      setDeletingId(null);
    }
  };

  /** Traduit les exceptions de archive_product() en messages utilisables. */
  function readableArchiveError(message: string, name: string): string {
    if (/Impossible d.archiver/i.test(message)) {
      // Le motif contient le nombre de ventes et le nom du produit.
      const nb = message.match(/apparaît dans (\d+) vente/);
      return `« ${name} » ne peut pas être archivé : il figure dans ${nb ? nb[1] : 'plusieurs'} vente(s). Mettez son stock à 0 et renommez-le « ${name} (épuisé) ».`;
    }
    if (/Droits insuffisants/.test(message)) {
      return 'Seul le patron peut archiver un produit.';
    }
    if (/Failed to fetch|NetworkError/i.test(message)) {
      return 'Connexion impossible. Vérifiez votre réseau et réessayez.';
    }
    return message;
  }

  const lowStock = products.filter((p) => p.stock_qty < p.min_stock_level).length;

  return (
    <div className="space-y-4">
      {deleteError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {deleteError}
        </div>
      )}
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Rechercher..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {isFeatureAllowed(plan, 'exportCsv') && (
          <Button onClick={handleExport} variant="outline" className="gap-2 shrink-0 border-slate-200">
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">CSV</span>
          </Button>
        )}
        {/* Un caissier n'a pas les droits d'écriture sur le catalogue (RLS
            products_insert/update/delete) : on ne propose pas le bouton. */}
        {canManageProducts && (
          <Button onClick={onAdd} className="bg-indigo-600 hover:bg-indigo-700 gap-2 shrink-0">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Ajouter</span>
          </Button>
        )}
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
                <TableCell colSpan={5} className="text-center text-slate-500 py-10">
                  {products.length === 0 ? (
                    <EmptyState
                      icon={PackagePlus}
                      title="Aucun produit"
                      hint="Ajoutez votre premier produit : nom, prix de vente et stock de départ."
                      action={{ label: 'Ajouter un produit', onClick: onAdd }}
                      className="py-2"
                    />
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
                      {p.sku && <div className="text-xs text-slate-500 font-mono">{p.sku}</div>}
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
                      {canManageProducts ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => onRestock(p)}
                            title="Réapprovisionner"
                            className="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50"
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
                            onClick={() => handleArchive(p)}
                            disabled={deletingId === p.id}
                            title="Archiver"
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-40"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {filtered.length} / {products.length} produit{products.length > 1 ? 's' : ''}
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              aria-label="Page précédente"
              onClick={() => setCurrentPage(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              className="px-2 py-1 text-xs rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50"
            >
              ←
            </button>
            <span className="text-xs text-slate-500">{safePage} / {totalPages}</span>
            <button
              aria-label="Page suivante"
              onClick={() => setCurrentPage(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
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
