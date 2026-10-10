import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * L'onglet Inventaire : catalogue par défaut, comptage à la demande, et le
 * bouton « Faire un inventaire » caché à un simple caissier (l'écriture est de
 * toute façon refusée en base).
 *
 * Les modules lourds sont mockés : on vérifie l'aiguillage et les droits.
 */
vi.mock('@/components/inventory/InventoryTable', () => ({ InventoryTable: () => <div>CATALOGUE</div> }));
vi.mock('@/components/inventory/InventoryCount', () => ({ InventoryCount: () => <div>COMPTAGE</div> }));
vi.mock('@/components/purchases/PurchaseOrdersModule', () => ({ PurchaseOrdersModule: () => <div>COMMANDES</div> }));

import { InventoryTab } from '@/components/inventory/InventoryTab';
import type { Product } from '@/types';

const noop = () => {};
const base = {
  products: [] as Product[], canManageProducts: true, showCount: false,
  onToggleCount: noop, onCountComplete: noop, onEdit: noop, onRestock: noop,
  onAdd: noop, onImport: noop, onRefresh: noop,
};

describe('InventoryTab', () => {
  it('montre le catalogue et les commandes par défaut', () => {
    render(<InventoryTab {...base} />);
    expect(screen.getByText('CATALOGUE')).toBeInTheDocument();
    expect(screen.queryByText('COMPTAGE')).toBeNull();
    expect(screen.getByText('COMMANDES')).toBeInTheDocument();
  });

  it('bascule vers le comptage quand showCount est vrai', () => {
    render(<InventoryTab {...base} showCount />);
    expect(screen.getByText('COMPTAGE')).toBeInTheDocument();
    expect(screen.queryByText('CATALOGUE')).toBeNull();
    expect(screen.getByRole('button', { name: 'Voir le catalogue' })).toBeInTheDocument();
  });

  it('déclenche la bascule au clic', () => {
    const onToggleCount = vi.fn();
    render(<InventoryTab {...base} onToggleCount={onToggleCount} />);
    screen.getByRole('button', { name: 'Faire un inventaire' }).click();
    expect(onToggleCount).toHaveBeenCalledTimes(1);
  });

  it('cache le bouton d’inventaire à un caissier', () => {
    render(<InventoryTab {...base} canManageProducts={false} />);
    expect(screen.queryByRole('button', { name: /inventaire/i })).toBeNull();
    // Le catalogue reste consultable.
    expect(screen.getByText('CATALOGUE')).toBeInTheDocument();
  });
});
