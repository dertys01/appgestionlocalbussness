import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Le tableau d'inventaire.
 *
 * On protège surtout le comptage : une alerte stock ou un export qui comptent
 * des produits ARCHIVÉS donnent un chiffre faux — et un produit archivé n'est
 * plus vendu, donc son « stock critique » est un faux signal.
 */

const h = vi.hoisted(() => {
  const role = { manage: true };
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  const getUser = vi.fn(async () => ({ data: { user: { id: 'u1', email: 'a@b.c' } }, error: null }));
  const supabase = { rpc, auth: { getUser } };
  const exportMod = { toCSV: vi.fn((rows: unknown[]) => `csv:${rows.length}`), downloadCSV: vi.fn() };
  const retirer = vi.fn(async () => ({ supprimes: 0, archives: 0 }));
  return { role, rpc, getUser, supabase, exportMod, retirer };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase, plan: 'pro', canManageProducts: h.role.manage,
    ownerId: 'org-1', actorName: 'Patron',
  }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('@/lib/utils/export', () => h.exportMod);
vi.mock('@/lib/starterCatalog.client', () => ({ removeStarterCatalog: h.retirer }));

import { InventoryTable } from '@/components/inventory/InventoryTable';
import type { Product } from '@/types';

function produit(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', user_id: 'org-1', name: 'Riz blanc', sku: 'RIZ-1', price_buy: 400,
    price_sell: 500, stock_qty: 10, min_stock_level: 3, category: 'Céréales',
    unit: 'kg', is_active: true, archived_at: null, supplier_id: null,
    menu_days: null, created_at: '', updated_at: '', ...over,
  };
}

const noop = () => {};
const rendu = (products: Product[]) =>
  render(<InventoryTable products={products} onEdit={noop} onRestock={noop} onAdd={noop} onImport={noop} onRefresh={noop} />);

beforeEach(() => {
  h.role.manage = true;
  h.rpc.mockClear();
  h.exportMod.toCSV.mockClear();
  h.exportMod.downloadCSV.mockClear();
});

describe('InventoryTable', () => {
  it('masque les archivés et ne les compte pas dans l’alerte stock', () => {
    rendu([
      produit({ id: 'p1', name: 'Riz blanc', stock_qty: 1, min_stock_level: 3 }),
      produit({ id: 'p2', name: 'Vieux stock', sku: 'OLD-1', stock_qty: 0, min_stock_level: 3, is_active: false }),
    ]);

    // Un seul critique : l'archivé, quoique sous son seuil, n'est pas compté.
    // Le libellé est réparti entre le <strong> et le texte : on lit le <strong>.
    expect(screen.getByText('1 produit')).toBeInTheDocument();
    expect(screen.getByText(/en stock critique/i)).toBeInTheDocument();
    expect(screen.queryByText('Vieux stock')).toBeNull();
  });

  it('filtre la liste par la recherche', () => {
    rendu([
      produit({ id: 'p1', name: 'Riz blanc' }),
      produit({ id: 'p2', name: 'Huile de palme', sku: 'HUI-1' }),
    ]);

    fireEvent.change(screen.getByLabelText(/Rechercher un produit/i), { target: { value: 'huile' } });

    expect(screen.getByText('Huile de palme')).toBeInTheDocument();
    expect(screen.queryByText('Riz blanc')).toBeNull();
  });

  it('n’exporte en CSV que les produits actifs', () => {
    rendu([
      produit({ id: 'p1', name: 'Riz blanc' }),
      produit({ id: 'p2', name: 'Vieux stock', sku: 'OLD-1', is_active: false }),
    ]);

    fireEvent.click(screen.getByLabelText(/Exporter l'inventaire en CSV/i));

    const lignes = h.exportMod.toCSV.mock.calls[0][0] as unknown[];
    expect(lignes).toHaveLength(1);
    expect(h.exportMod.downloadCSV).toHaveBeenCalledTimes(1);
  });

  it('archive un produit après confirmation', async () => {
    rendu([produit()]);

    fireEvent.click(screen.getByLabelText('Archiver Riz blanc'));
    // Le dialogue demande confirmation avant d'écrire.
    expect(screen.getByText(/Archiver ce produit/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archiver' }));

    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('archive_product', { p_product_id: 'p1' }));
  });

  it('un caissier ne voit aucune action d’écriture', () => {
    h.role.manage = false;
    rendu([produit()]);

    expect(screen.queryByLabelText('Ajouter un produit')).toBeNull();
    expect(screen.queryByLabelText(/Importer des produits/i)).toBeNull();
    expect(screen.queryByLabelText('Archiver Riz blanc')).toBeNull();
  });

  it('pagine au-delà de vingt lignes', () => {
    const produits = Array.from({ length: 21 }, (_, i) =>
      produit({ id: `p${i}`, name: `Produit ${String(i + 1).padStart(2, '0')}`, sku: `SKU-${i}` }),
    );
    rendu(produits);

    expect(screen.queryByText('Produit 21')).toBeNull();
    fireEvent.click(screen.getByLabelText('Page suivante'));
    expect(screen.getByText('Produit 21')).toBeInTheDocument();
  });
});
