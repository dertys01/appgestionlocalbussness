'use client';

import { useMemo } from 'react';
import { Package, TrendingUp, AlertTriangle, ShoppingCart } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatCFA } from '@/lib/utils/currency';
import type { Product } from '@/types';

interface DashboardTabProps {
  products: Product[];
  canManageProducts: boolean;
  onNewSale: () => void;
  onAddProduct: () => void;
  onRestock: (product: Product) => void;
}

export function DashboardTab({ products, canManageProducts, onNewSale, onAddProduct, onRestock }: DashboardTabProps) {
  const totalProducts = products.length;
  const lowStockCount = useMemo(
    () => products.filter((p) => p.stock_qty < p.min_stock_level).length,
    [products]
  );
  const totalStockValue = useMemo(
    () => products.reduce((s, p) => s + p.price_sell * p.stock_qty, 0),
    [products]
  );

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-slate-800">Tableau de bord</h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
              <Package className="h-4 w-4" /> Produits
            </div>
            <div className="text-2xl font-bold text-slate-800">{totalProducts}</div>
          </CardContent>
        </Card>
        <Card className="border-slate-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
              <TrendingUp className="h-4 w-4" /> Valeur stock
            </div>
            <div className="text-xl font-bold text-indigo-600">{formatCFA(totalStockValue)}</div>
          </CardContent>
        </Card>
        <Card className={`col-span-2 sm:col-span-1 ${lowStockCount > 0 ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}>
          <CardContent className="p-4">
            <div className={`flex items-center gap-2 text-sm mb-1 ${lowStockCount > 0 ? 'text-red-600' : 'text-slate-500'}`}>
              <AlertTriangle className="h-4 w-4" /> Stock critique
            </div>
            <div className={`text-2xl font-bold ${lowStockCount > 0 ? 'text-red-600' : 'text-slate-800'}`}>
              {lowStockCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className={`grid gap-3 ${canManageProducts ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <Button onClick={onNewSale} className="h-20 flex flex-col gap-1 bg-indigo-600 hover:bg-indigo-700 rounded-xl">
          <ShoppingCart className="h-6 w-6" />
          <span>Nouvelle vente</span>
        </Button>
        {canManageProducts && (
          <Button onClick={onAddProduct} variant="outline" className="h-20 flex flex-col gap-1 rounded-xl border-slate-200">
            <Package className="h-6 w-6 text-indigo-600" />
            <span>Ajouter produit</span>
          </Button>
        )}
      </div>

      {lowStockCount > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-red-600 flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" /> À réapprovisionner
          </h3>
          {products.filter((p) => p.stock_qty < p.min_stock_level).map((p) => (
            <Card key={p.id} className="border-red-200 bg-red-50">
              <CardContent className="p-3 flex justify-between items-center">
                <div>
                  <div className="font-medium text-slate-800 text-sm">{p.name}</div>
                  <div className="text-xs text-red-600">Stock : {p.stock_qty} / min {p.min_stock_level}</div>
                </div>
                {canManageProducts && (
                  <button
                    onClick={() => onRestock(p)}
                    className="text-xs bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-emerald-800"
                  >
                    Réappro.
                  </button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
