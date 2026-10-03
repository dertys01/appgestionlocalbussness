'use client';

import { useState, useRef, useCallback } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  History,
  Handshake,
  BarChart2,
  Brain,
  Users,
} from 'lucide-react';
import { LoginPage } from '@/components/auth/LoginPage';
import { InventoryTab } from '@/components/inventory/InventoryTab';
import { POSModule } from '@/components/pos/POSModule';
import { SalesHistory } from '@/components/sales/SalesHistory';
import { DebtsModule } from '@/components/debts/DebtsModule';
import { ReportsTab } from '@/components/reports/ReportsTab';
import { ForecastModule } from '@/components/forecast/ForecastModule';
import { TeamModule } from '@/components/team/TeamModule';
import { ProductForm } from '@/components/products/ProductForm';
import { RestockModal } from '@/components/products/RestockModal';
import { ProductImportModal } from '@/components/inventory/ProductImportModal';
import { BarcodeScanner } from '@/components/scanner/BarcodeScanner';
import { SettingsModule } from '@/components/settings/SettingsModule';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';
import { OrgLoadFailed } from '@/components/onboarding/OrgLoadFailed';
import { OrgSetupRequired } from '@/components/onboarding/OrgSetupRequired';
import { DashboardTab } from '@/components/dashboard/DashboardTab';
import { Sidebar } from '@/components/layout/Sidebar';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { useProducts } from '@/lib/hooks/useProducts';
import { isFeatureAllowed } from '@/lib/utils/plans';
import type { NavItem, Product, ReportView, Tab } from '@/types';

export default function HomePage() {
  const { supabase, user, loading, isEmployee, canManageProducts, org, plan, orgError } = useSupabase();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [reportView, setReportView] = useState<ReportView>('sales');
  const { products, loadingProducts, productsError, fetchProducts } = useProducts();
  const [showScanner, setShowScanner] = useState(false);
  const [showInventoryCount, setShowInventoryCount] = useState(false);
  const [scanNotFound, setScanNotFound] = useState('');
  // Demande transmise au POS pour y ajouter le produit scanné.
  const [addToCartRequest, setAddToCartRequest] = useState<{ productId: string; token: number } | null>(null);
  // Compteur strictement croissant : deux scans dans la même milliseconde ne
  // doivent pas recevoir le même jeton, sinon le POS croirait une demande déjà
  // traitée et n'ajouterait que la première.
  const scanSeq = useRef(0);
  // Identité stable : passé en dépendance de l'effet du POS, un arrow inline
  // le relancerait à chaque render.
  const handleAddToCartHandled = useCallback(() => setAddToCartRequest(null), []);

  // Modals produits
  const [showProductForm, setShowProductForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [restockProduct, setRestockProduct] = useState<Product | null>(null);
  // Même règle que canManageProducts : un prédicat nommé rend les sites
  // d'appel explicites. La vraie barrière reste la RLS.
  const canRestock = () => canManageProducts;

  const handleScan = (sku: string) => {
    // Correspondance insensible à la casse et aux espaces : les scanners
    // renvoient parfois des codes-barres avec des caractères parasites.
    const normalized = sku.trim().toLowerCase();
    const product = products.find(
      (p) => (p.sku ?? '').trim().toLowerCase() === normalized
    );

    if (product) {
      setScanNotFound('');
      setShowScanner(false);
      setTab('pos');
      // Le panier vit dans POSModule : on passe par une requête datée, sinon
      // scanner deux fois le même produit n'ajouterait qu'une unité.
      scanSeq.current += 1;
      setAddToCartRequest({ productId: product.id, token: scanSeq.current });
    } else {
      setScanNotFound(`Aucun produit trouvé pour le code-barres : ${sku}`);
    }
  };

  const openAdd = () => {
    if (!canManageProducts) return;
    setEditingProduct(null);
    setShowProductForm(true);
  };
  const openEdit = (p: Product) => {
    if (!canManageProducts) return;
    setEditingProduct(p);
    setShowProductForm(true);
  };
  const openRestock = (p: Product) => {
    if (!canRestock()) return;
    setRestockProduct(p);
  };

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

  // Org absente = register interrompu avant la création de l'org
  // orgError = la lecture a ÉCHOUÉ. Les deux ne disent pas la même chose :
  // afficher « Configuration requise » dans le second cas invite à recréer une
  // boutique qui existe déjà, et l'INSERT échoue sur la clé primaire.
  if (!isEmployee && !org) {
    return orgError ? <OrgLoadFailed error={orgError} /> : <OrgSetupRequired />;
  }

  const NAV_ITEMS: NavItem[] = [
    { key: 'dashboard', label: 'Accueil',    icon: LayoutDashboard, locked: false },
    { key: 'pos',       label: 'Vente',      icon: ShoppingCart,    locked: false },
    { key: 'inventory', label: 'Stock',      icon: Package,         locked: false },
    { key: 'sales',     label: 'Ventes',     icon: History,         locked: false },
    { key: 'debts',     label: 'Dettes',     icon: Handshake,       locked: !isFeatureAllowed(plan, 'reports') },
    { key: 'reports',   label: 'Rapports',   icon: BarChart2,       locked: !isFeatureAllowed(plan, 'reports') },
    { key: 'forecast',  label: 'Prévisions', icon: Brain,           locked: !isFeatureAllowed(plan, 'forecast') },
    { key: 'team',      label: 'Équipe',     icon: Users,           locked: false },
  ];

  return (
    <div className="min-h-screen flex">

      {/* ── Sidebar gauche ── */}
      <Sidebar
        tab={tab}
        items={NAV_ITEMS}
        email={user.email}
        loadingProducts={loadingProducts}
        onTab={setTab}
        onScan={() => setShowScanner(true)}
        onRefresh={fetchProducts}
        onSignOut={() => supabase.auth.signOut()}
      />

      {/* ── Contenu principal ── */}
      <main className="flex-1 ml-16 lg:ml-56 min-h-screen bg-slate-50">
        <div className="p-4 max-w-5xl mx-auto">

          {/* Erreur de chargement des produits : HORS condition d'onglet.
              Rendue uniquement dans le dashboard, elle était invisible dès
              qu'un autre onglet était actif — l'utilisateur voyait une liste
              vide sans aucune explication. */}
          {productsError && (
            <p className="mb-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              Impossible de charger les produits : {productsError}
            </p>
          )}

          {/* ── Dashboard ── */}
          {tab === 'dashboard' && (
            <DashboardTab
              products={products}
              canManageProducts={canManageProducts}
              onNewSale={() => setTab('pos')}
              onAddProduct={openAdd}
              onRestock={openRestock}
            />
          )}

          {tab === 'pos' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Point de vente</h2>
              <POSModule
                products={products}
                onSaleComplete={fetchProducts}
                addToCartRequest={addToCartRequest}
                onAddToCartHandled={handleAddToCartHandled}
              />
            </div>
          )}

          {tab === 'inventory' && (
            <InventoryTab
              products={products}
              canManageProducts={canManageProducts}
              showCount={showInventoryCount}
              onToggleCount={() => setShowInventoryCount(!showInventoryCount)}
              onCountComplete={() => { setShowInventoryCount(false); fetchProducts(); }}
              onEdit={openEdit}
              onRestock={openRestock}
              onAdd={openAdd}
              onImport={() => setShowImport(true)}
              onRefresh={fetchProducts}
            />
          )}

          {tab === 'sales' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold text-slate-800">Historique des ventes</h2>
              <SalesHistory />
            </div>
          )}

          {tab === 'debts' && (
            <div className="space-y-4">
              <DebtsModule />
            </div>
          )}

          {tab === 'reports' && (
            <ReportsTab view={reportView} onView={setReportView} />
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
      {showProductForm && canManageProducts && (
        <ProductForm
          product={editingProduct}
          onClose={() => setShowProductForm(false)}
          onSaved={fetchProducts}
          currentProductCount={products.length}
        />
      )}
      {showImport && canManageProducts && (
        <ProductImportModal
          products={products}
          onClose={() => setShowImport(false)}
          onDone={fetchProducts}
        />
      )}
      {restockProduct && canManageProducts && (
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
