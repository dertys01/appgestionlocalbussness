'use client';

import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  History,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  LogOut,
  ScanBarcode,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InventoryTable } from '@/components/inventory/InventoryTable';
import { POSModule } from '@/components/pos/POSModule';
import { SalesHistory } from '@/components/sales/SalesHistory';
import { ProductForm } from '@/components/products/ProductForm';
import { RestockModal } from '@/components/products/RestockModal';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import type { Product } from '@/types';

type Tab = 'dashboard' | 'pos' | 'inventory' | 'sales';

export default function HomePage() {
  const { supabase, user, loading } = useSupabase();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  // Modals produits
  const [showProductForm, setShowProductForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [restockProduct, setRestockProduct] = useState<Product | null>(null);

  const totalProducts = products.length;
  const lowStockCount = products.filter((p) => p.stock_qty < p.min_stock_level).length;
  const totalStockValue = products.reduce((s, p) => s + p.price_sell * p.stock_qty, 0);

  const fetchProducts = async () => {
    if (!user) return;
    setLoadingProducts(true);
    const { data } = await supabase.from('products').select('*').order('name');
    setProducts((data as Product[]) ?? []);
    setLoadingProducts(false);
  };

  useEffect(() => {
    if (user) fetchProducts();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScan = (sku: string) => {
    const product = products.find((p) => p.sku === sku);
    if (product) setTab('pos');
    else alert(`Aucun produit trouvé pour le SKU : ${sku}`);
  };

  const openAdd = () => { setEditingProduct(null); setShowProductForm(true); };
  const openEdit = (p: Product) => { setEditingProduct(p); setShowProductForm(true); };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="font-bold text-indigo-600 text-lg leading-none">GestionLocal</h1>
          <p className="text-xs text-slate-400 truncate max-w-[180px]">{user.email}</p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowScanner(true)} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100">
            <ScanBarcode className="h-5 w-5" />
          </button>
          <button onClick={fetchProducts} disabled={loadingProducts} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40">
            <RefreshCw className={`h-5 w-5 ${loadingProducts ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => supabase.auth.signOut()} className="p-2 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-500">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Contenu */}
      <main className="flex-1 p-4 pb-24 max-w-5xl mx-auto w-full">

        {/* ── Dashboard ── */}
        {tab === 'dashboard' && (
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
                  <div className={`flex items-center gap-2 text-sm mb-1 ${lowStockCount > 0 ? 'text-red-500' : 'text-slate-500'}`}>
                    <AlertTriangle className="h-4 w-4" /> Stock critique
                  </div>
                  <div className={`text-2xl font-bold ${lowStockCount > 0 ? 'text-red-600' : 'text-slate-800'}`}>
                    {lowStockCount}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Accès rapide */}
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={() => setTab('pos')} className="h-20 flex flex-col gap-1 bg-indigo-600 hover:bg-indigo-700 rounded-xl">
                <ShoppingCart className="h-6 w-6" />
                <span>Nouvelle vente</span>
              </Button>
              <Button onClick={openAdd} variant="outline" className="h-20 flex flex-col gap-1 rounded-xl border-slate-200">
                <Package className="h-6 w-6 text-indigo-600" />
                <span>Ajouter produit</span>
              </Button>
            </div>

            {/* Produits critiques */}
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
                        <div className="text-xs text-red-500">Stock : {p.stock_qty} / min {p.min_stock_level}</div>
                      </div>
                      <button
                        onClick={() => setRestockProduct(p)}
                        className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-emerald-700"
                      >
                        Réappro.
                      </button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── POS ── */}
        {tab === 'pos' && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-slate-800">Point de vente</h2>
            <POSModule products={products} onSaleComplete={fetchProducts} />
          </div>
        )}

        {/* ── Inventaire ── */}
        {tab === 'inventory' && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-slate-800">Inventaire</h2>
            <InventoryTable
              products={products}
              onEdit={openEdit}
              onRestock={(p) => setRestockProduct(p)}
              onAdd={openAdd}
              onRefresh={fetchProducts}
            />
          </div>
        )}

        {/* ── Historique ventes ── */}
        {tab === 'sales' && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-slate-800">Historique des ventes</h2>
            <SalesHistory />
          </div>
        )}
      </main>

      {/* Navigation mobile */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex z-40">
        {(
          [
            { key: 'dashboard', label: 'Accueil', icon: LayoutDashboard },
            { key: 'pos',       label: 'Vente',   icon: ShoppingCart },
            { key: 'inventory', label: 'Stock',   icon: Package },
            { key: 'sales',     label: 'Ventes',  icon: History },
          ] as { key: Tab; label: string; icon: React.ElementType }[]
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 flex flex-col items-center justify-center py-3 text-xs font-medium transition-colors ${
              tab === key ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Icon className="h-5 w-5 mb-0.5" />
            {label}
          </button>
        ))}
      </nav>

      {/* Modals */}
      {showProductForm && (
        <ProductForm
          product={editingProduct}
          onClose={() => setShowProductForm(false)}
          onSaved={fetchProducts}
        />
      )}

      {restockProduct && (
        <RestockModal
          product={restockProduct}
          onClose={() => setRestockProduct(null)}
          onSaved={fetchProducts}
        />
      )}

      {showScanner && (
        <BarcodeScanner onScan={handleScan} onClose={() => setShowScanner(false)} />
      )}
    </div>
  );
}

// ── Page de connexion ──
function LoginPage() {
  const { supabase } = useSupabase();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError('Email ou mot de passe incorrect.');
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">Connectez-vous à votre espace</p>
        </div>
        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="vous@exemple.com"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-700">Mot de passe</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                {loading ? 'Connexion...' : 'Se connecter'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
