'use client';

import { InventoryTable } from '@/components/inventory/InventoryTable';
import { InventoryCount } from '@/components/inventory/InventoryCount';
import type { Product } from '@/types';

interface InventoryTabProps {
  products: Product[];
  canManageProducts: boolean;
  showCount: boolean;
  onToggleCount: () => void;
  onCountComplete: () => void;
  onEdit: (product: Product) => void;
  onRestock: (product: Product) => void;
  onAdd: () => void;
  onImport: () => void;
  onRefresh: () => void;
}

export function InventoryTab({
  products, canManageProducts, showCount, onToggleCount, onCountComplete,
  onEdit, onRestock, onAdd, onImport, onRefresh,
}: InventoryTabProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-800">Inventaire</h2>
        {/* Caché pour un simple caissier : l'inventaire réécrit les
            stocks, et products_update impose déjà can_manage_products()
            en base. Proposer le bouton, c'était offrir une action que la
            base refuse — l'erreur n'apparaissait qu'à l'enregistrement. */}
        {canManageProducts && (
          <button
            onClick={onToggleCount}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              showCount
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            {showCount ? 'Voir le catalogue' : 'Faire un inventaire'}
          </button>
        )}
      </div>
      {showCount ? (
        <InventoryCount products={products} onComplete={onCountComplete} />
      ) : (
        <InventoryTable products={products} onEdit={onEdit} onRestock={onRestock} onAdd={onAdd} onImport={onImport} onRefresh={onRefresh} />
      )}
    </div>
  );
}
