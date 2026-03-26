'use client';

import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  History,
  BarChart2,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  LogOut,
  ScanBarcode,
  Brain,
  Users,
  Settings,
  Lock,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InventoryTable } from '@/components/inventory/InventoryTable';
import { InventoryCount } from '@/components/inventory/InventoryCount';
import { POSModule } from '@/components/pos/POSModule';
import { SalesHistory } from '@/components/sales/SalesHistory';
import { ReportsModule } from '@/components/reports/ReportsModule';
import { ForecastModule } from '@/components/forecast/ForecastModule';
import { TeamModule } from '@/components/team/TeamModule';
import { ProductForm } from '@/components/products/ProductForm';
import { RestockModal } from '@/components/products/RestockModal';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { SettingsModule } from '@/components/settings/SettingsModule';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { formatCFA } from '@/lib/utils/currency';
import { isFeatureAllowed } from '@/lib/utils/plans';
import type { Product } from '@/types';

type Tab = 'dashboard' | 'pos' | 'inventory' | 'sales' | 'reports' | 'forecast' | 'team' | 'settings';

export default function HomePage() {
  const { supabase, user, loading, isEmployee, org, plan } = useSupabase();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showInventoryCount, setShowInventoryCount] = useState(false);
  const [scanNotFound, setScanNotFound] = useState('');

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
    if (product) {
      setScanNotFound('');
      setShowScanner(false);
      setTab('pos');
    } else {
      setScanNotFound(`Aucun produit trouvé pour le SKU : ${sku}`);
    }
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

  // Onboarding : nouveau compte sans org ou onboarding non terminé
  if (!isEmployee && org && !org.onboarding_done) {
    return <OnboardingWizard onComplete={fetchProducts} />;
  }

  const NAV_ITEMS = [
    { key: 'dashboard', label: 'Accueil',    icon: LayoutDashboard, locked: false },
    { key: 'pos',       label: 'Vente',      icon: ShoppingCart,    locked: false },
    { key: 'inventory', label: 'Stock',      icon: Package,         locked: false },
    { key: 'sales',     label: 'Ventes',     icon: History,         locked: false },
    { key: 'reports',   label: 'Rapports',   icon: BarChart2,       locked: !isFeatureAllowed(plan, 'reports') },
    { key: 'forecast',  label: 'Prévisions', icon: Brain,           locked: !isFeatureAllowed(plan, 'forecast') },
    { key: 'team',      label: 'Équipe',     icon: Users,           locked: false },
  ] as { key: Tab; label: string; icon: React.ElementType; locked: boolean }[];

  return (
    <div className="min-h-screen flex">

      {/* ── Sidebar gauche ── */}
      <aside className="fixed left-0 top-0 h-full z-40 flex flex-col bg-white border-r border-slate-200 w-16 lg:w-56 transition-all">
        {/* Logo */}
        <div className="px-3 lg:px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
              <LayoutDashboard className="h-4 w-4 text-white" />
            </div>
            <span className="hidden lg:block font-bold text-indigo-600 text-sm leading-tight">GestionLocal</span>
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-3 space-y-1 px-2">
          {NAV_ITEMS.map(({ key, label, icon: Icon, locked }) => (
            <button
              key={key}
              onClick={() => { if (!locked) setTab(key as Tab); else setTab('settings'); }}
              title={locked ? `${label} — Plan supérieur requis` : label}
              className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                tab === key
                  ? 'bg-indigo-50 text-indigo-600'
                  : locked
                    ? 'text-slate-300 cursor-pointer'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="hidden lg:flex lg:items-center lg:gap-1.5">
                {label}
                {locked && <Lock className="h-3 w-3 text-slate-300" />}
              </span>
            </button>
          ))}
        </nav>

        {/* Footer sidebar */}
        <div className="border-t border-slate-100 p-2 space-y-1">
          <button
            onClick={() => setTab('settings')}
            title="Paramètres"
            className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              tab === 'settings' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Settings className="h-5 w-5 shrink-0" />
            <span className="hidden lg:block">Paramètres</span>
          </button>
          <button
            onClick={() => setShowScanner(true)}
            title="Scanner"
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-50"
          >
            <ScanBarcode className="h-5 w-5 shrink-0" />
            <span className="hidden lg:block">Scanner</span>
          </button>
          <button
            onClick={fetchProducts}
            disabled={loadingProducts}
            title="Actualiser"
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            <RefreshCw className={`h-5 w-5 shrink-0 ${loadingProducts ? 'animate-spin' : ''}`} />
            <span className="hidden lg:block">Actualiser</span>
          </button>
          <div className="hidden lg:block px-2 py-1">
            <p className="text-xs text-slate-400 truncate">{user.email}</p>
          </div>
          <button
            onClick={() => supabase.auth.signOut()}
            title="Déconnexion"
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm text-red-400 hover:bg-red-50 hover:text-red-600"
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className="hidden lg:block">Déconnexion</span>
          </button>
        </div>
      </aside>

      {/* ── Contenu principal ── */}
      <main className="flex-1 ml-16 lg:ml-56 min-h-screen bg-slate-50">
        <div className="p-4 max-w-5xl mx-auto">

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

          {tab === 'pos' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Point de vente</h2>
              <POSModule products={products} onSaleComplete={fetchProducts} />
            </div>
          )}

          {tab === 'inventory' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-800">Inventaire</h2>
                <button
                  onClick={() => setShowInventoryCount(!showInventoryCount)}
                  className={`text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                    showInventoryCount
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {showInventoryCount ? 'Voir le catalogue' : '📋 Faire un inventaire'}
                </button>
              </div>
              {showInventoryCount ? (
                <InventoryCount products={products} onComplete={() => { setShowInventoryCount(false); fetchProducts(); }} />
              ) : (
                <InventoryTable products={products} onEdit={openEdit} onRestock={(p) => setRestockProduct(p)} onAdd={openAdd} onRefresh={fetchProducts} />
              )}
            </div>
          )}

          {tab === 'sales' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Historique des ventes</h2>
              <SalesHistory />
            </div>
          )}

          {tab === 'reports' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Rapports & Analyses</h2>
              <ReportsModule />
            </div>
          )}

          {tab === 'forecast' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Prévisions & Planification</h2>
              <ForecastModule onRestock={fetchProducts} />
            </div>
          )}

          {tab === 'team' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">
                {isEmployee ? 'Journal d\'activité' : 'Équipe & Journal'}
              </h2>
              <TeamModule />
            </div>
          )}

          {tab === 'settings' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Paramètres</h2>
              <SettingsModule />
            </div>
          )}
        </div>
      </main>

      {/* Modals */}
      {showProductForm && (
        <ProductForm
          product={editingProduct}
          onClose={() => setShowProductForm(false)}
          onSaved={fetchProducts}
          currentProductCount={products.length}
        />
      )}
      {restockProduct && (
        <RestockModal product={restockProduct} onClose={() => setRestockProduct(null)} onSaved={fetchProducts} />
      )}
      {showScanner && (
        <BarcodeScanner
          onScan={handleScan}
          onClose={() => { setShowScanner(false); setScanNotFound(''); }}
          errorMessage={scanNotFound}
        />
      )}
    </div>
  );
}

// ── Page de connexion / inscription ──
function LoginPage() {
  const { supabase } = useSupabase();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const switchMode = (m: 'login' | 'register') => {
    setMode(m);
    setError('');
    setInfo('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError('Email ou mot de passe incorrect.');
    setLoading(false);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setInfo('');

    const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    const userId = data.user?.id;
    if (!userId) {
      setError('Erreur lors de la création du compte.');
      setLoading(false);
      return;
    }

    // Si pas de session → confirmation email requise (désactiver dans Supabase Auth settings)
    if (!data.session) {
      setInfo('Vérifiez votre email pour confirmer votre compte, puis reconnectez-vous.');
      setLoading(false);
      return;
    }

    const slug = businessName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
    const { error: orgError } = await supabase.from('organizations').insert({
      id: userId,
      name: businessName.trim(),
      slug,
      plan: 'free',
      onboarding_done: false,
    });

    if (orgError) {
      setError(`Erreur configuration : ${orgError.message}`);
      setLoading(false);
      return;
    }

    setLoading(false);
    // SupabaseProvider détecte SIGNED_IN → charge l'org → OnboardingWizard s'affiche
  };

  const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">
            {mode === 'login' ? 'Connectez-vous à votre espace' : 'Créez votre boutique'}
          </p>
        </div>

        {/* Toggle login / register */}
        <div className="flex rounded-xl bg-slate-100 p-1 mb-4">
          <button
            onClick={() => switchMode('login')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${mode === 'login' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
          >
            Se connecter
          </button>
          <button
            onClick={() => switchMode('register')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${mode === 'register' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
          >
            Créer un compte
          </button>
        </div>

        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            {mode === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.com" className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Mot de passe</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" className={inputClass} />
                </div>
                {error && <p className="text-red-500 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Connexion...' : 'Se connecter'}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Nom de votre boutique</label>
                  <input type="text" value={businessName} onChange={(e) => setBusinessName(e.target.value)} required placeholder="Ex: Épicerie Adjonou" className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.com" className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Mot de passe</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="8 caractères minimum" minLength={6} className={inputClass} />
                </div>
                {error && <p className="text-red-500 text-sm">{error}</p>}
                {info && <p className="text-indigo-600 text-sm">{info}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Création...' : 'Créer mon compte'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
