import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * La coquille de l'application (home-client) : elle décide QUOI afficher.
 *
 * On verrouille les décisions, pas les modules (mockés) : écran de chargement,
 * accueil public sans session, onboarding, boutique absente vs illisible,
 * filtrage des onglets par domaine, onglets verrouillés par le plan, bannière
 * hors-ligne, erreur produits visible partout, et la navigation entre onglets.
 */

const h = vi.hoisted(() => {
  const state = {
    loading: false,
    user: { id: 'u1', email: 'p@b.c' } as { id: string; email?: string } | null,
    isEmployee: false,
    canManageProducts: true,
    org: { domain: 'retail', ui_mode: 'full', onboarding_done: true, onboarding_step: null } as Record<string, unknown> | null,
    plan: 'pro' as 'free' | 'starter' | 'pro',
    orgError: null as string | null,
    products: [] as unknown[],
    productsError: '',
    horsLigne: 0,
    file: [] as unknown[],
    relancer: [] as unknown[],
    navItems: [] as Array<{ key: string; label: string; locked?: boolean; badge?: number }>,
    supabase: { auth: { signOut: vi.fn(async () => ({})) }, rpc: vi.fn(async () => ({ data: [] as unknown[], error: null })) },
  };
  return { state };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.state.supabase, user: h.state.user, loading: h.state.loading,
    isEmployee: h.state.isEmployee, canManageProducts: h.state.canManageProducts,
    org: h.state.org, plan: h.state.plan, orgError: h.state.orgError,
  }),
}));
vi.mock('@/lib/hooks/useProducts', () => ({ useProducts: () => ({ products: h.state.products, loadingProducts: false, productsError: h.state.productsError, fetchProducts: vi.fn() }) }));
vi.mock('@/lib/hooks/useToday', () => ({ useToday: () => ({ today: null, todayError: '' }) }));
vi.mock('@/lib/hooks/useHistoriqueOnglets', () => ({ useHistoriqueOnglets: () => {} }));
vi.mock('@/lib/hooks/useOfflineSync', () => ({ useOfflineSync: () => ({ enAttente: h.state.horsLigne, syncing: false, synchroniser: vi.fn() }) }));
vi.mock('@/lib/offline/queue', () => ({ lireFile: async () => h.state.file }));

vi.mock('@/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: ({ items, onTab, onScan }: { items: Array<{ key: string; label: string; locked?: boolean; badge?: number }>; onTab: (k: string) => void; onScan: () => void }) => {
    h.state.navItems = items;
    return (
      <nav>
        {items.map((i) => (
          <button key={i.key} onClick={() => onTab(i.key)}>{i.label}</button>
        ))}
        <button onClick={onScan}>Scanner</button>
      </nav>
    );
  },
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/marketing/LandingPage', () => ({ LandingPage: () => <div>MOD:LandingPage</div> }));
vi.mock('@/components/dashboard/DashboardTab', () => ({ DashboardTab: () => <div>MOD:Dashboard</div> }));
vi.mock('@/components/pos/POSModule', () => ({ POSModule: ({ addToCartRequest }: { addToCartRequest?: { productId: string } | null }) => <div>MOD:POS{addToCartRequest ? `:${addToCartRequest.productId}` : ''}</div> }));
vi.mock('@/components/inventory/InventoryTab', () => ({ InventoryTab: ({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) => <div>MOD:Inventaire<button onClick={onAdd}>add</button><button onClick={onImport}>import</button></div> }));
vi.mock('@/components/sales/DailyJournal', () => ({ DailyJournal: () => <div>MOD:Journal</div> }));
vi.mock('@/components/sales/SalesHistory', () => ({ SalesHistory: () => <div>MOD:Historique</div> }));
vi.mock('@/components/debts/DebtsModule', () => ({ DebtsModule: () => <div>MOD:Dettes</div> }));
vi.mock('@/components/reports/ReportsTab', () => ({ ReportsTab: () => <div>MOD:Rapports</div> }));
vi.mock('@/components/forecast/ForecastModule', () => ({ ForecastModule: () => <div>MOD:Previsions</div> }));
vi.mock('@/components/restaurant/FloorModule', () => ({ FloorModule: () => <div>MOD:Salle</div> }));
vi.mock('@/components/restaurant/RecipesModule', () => ({ RecipesModule: () => <div>MOD:Recettes</div> }));
vi.mock('@/components/restaurant/ReservationsModule', () => ({ ReservationsModule: () => <div>MOD:Reservations</div> }));
vi.mock('@/components/team/TeamModule', () => ({ TeamModule: () => <div>MOD:Equipe</div> }));
vi.mock('@/components/settings/SettingsModule', () => ({ SettingsModule: () => <div>MOD:Parametres</div> }));
vi.mock('@/components/cash/CashSessionCard', () => ({ CashSessionCard: () => <div>MOD:Caisse</div> }));
vi.mock('@/components/products/ProductForm', () => ({ ProductForm: () => <div>MOD:FormProduit</div> }));
vi.mock('@/components/products/RestockModal', () => ({ RestockModal: () => <div>MOD:Reappro</div> }));
vi.mock('@/components/inventory/ProductImportModal', () => ({ ProductImportModal: () => <div>MOD:Import</div> }));
vi.mock('@/components/scanner/BarcodeScanner', () => ({ BarcodeScanner: ({ onScan, errorMessage }: { onScan: (s: string) => void; errorMessage?: string }) => (
  <div>MOD:Scanner<button onClick={() => onScan('RIZ-1')}>scan-riz</button><button onClick={() => onScan('INCONNU')}>scan-x</button>{errorMessage && <span>{errorMessage}</span>}</div>
) }));
vi.mock('@/components/onboarding/OnboardingWizard', () => ({ OnboardingWizard: () => <div>MOD:Assistant</div> }));
vi.mock('@/components/onboarding/GuidedCash', () => ({ GuidedCash: () => <div>MOD:CaisseGuidee</div> }));
vi.mock('@/components/onboarding/OrgLoadFailed', () => ({ OrgLoadFailed: () => <div>MOD:OrgLoadFailed</div> }));
vi.mock('@/components/onboarding/OrgSetupRequired', () => ({ OrgSetupRequired: () => <div>MOD:OrgSetupRequired</div> }));

import HomePage from '@/app/home-client';

beforeEach(() => {
  h.state.loading = false;
  h.state.user = { id: 'u1', email: 'p@b.c' };
  h.state.isEmployee = false;
  h.state.canManageProducts = true;
  h.state.org = { domain: 'retail', ui_mode: 'full', onboarding_done: true, onboarding_step: null };
  h.state.plan = 'pro';
  h.state.orgError = null;
  h.state.products = [];
  h.state.productsError = '';
  h.state.horsLigne = 0;
  h.state.file = [];
  h.state.relancer = [];
  h.state.navItems = [];
  h.state.supabase.rpc.mockImplementation(async () => ({ data: h.state.relancer, error: null }));
});

describe('home-client', () => {
  it('affiche un écran de chargement tant que la session n’est pas résolue', () => {
    h.state.loading = true;
    render(<HomePage />);
    expect(screen.queryByText('MOD:LandingPage')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accueil' })).toBeNull();
  });

  it('sans session : accueil public', () => {
    h.state.user = null;
    render(<HomePage />);
    expect(screen.getByText('MOD:LandingPage')).toBeInTheDocument();
  });

  it('onboarding non terminé : l’assistant, pas la navigation', () => {
    h.state.org = { domain: 'retail', ui_mode: 'full', onboarding_done: false, onboarding_step: null };
    render(<HomePage />);
    expect(screen.getByText('MOD:Assistant')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Caisse' })).toBeNull();
  });

  it('boutique absente → configuration requise ; lecture en échec → OrgLoadFailed', () => {
    h.state.org = null;
    h.state.orgError = null;
    const { unmount } = render(<HomePage />);
    expect(screen.getByText('MOD:OrgSetupRequired')).toBeInTheDocument();
    unmount();

    h.state.orgError = 'réseau indisponible';
    render(<HomePage />);
    expect(screen.getByText('MOD:OrgLoadFailed')).toBeInTheDocument();
  });

  it('commerce : onglets du domaine, pas de Salle', () => {
    render(<HomePage />);
    expect(screen.getByRole('button', { name: 'Accueil' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Caisse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salle' })).toBeNull();
  });

  it('restaurant : Salle et Recettes présentes', () => {
    h.state.org = { domain: 'restaurant', ui_mode: 'full', onboarding_done: true, onboarding_step: null };
    render(<HomePage />);
    expect(screen.getByRole('button', { name: 'Salle' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recettes' })).toBeInTheDocument();
  });

  it('verrouille Rapports et Prévisions hors plan', () => {
    h.state.plan = 'free';
    render(<HomePage />);
    const rapports = h.state.navItems.find((i) => i.key === 'reports');
    const previsions = h.state.navItems.find((i) => i.key === 'forecast');
    expect(rapports?.locked).toBe(true);
    expect(previsions?.locked).toBe(true);
  });

  it('bannière hors-ligne : compte les ventes en attente et ouvre la file', async () => {
    h.state.horsLigne = 2;
    h.state.file = [{ ref: 'r1', cree: '2026-10-01T10:00:00Z', resume: { libelle: 'Vente 1', total: 1500 } }];
    render(<HomePage />);

    expect(screen.getByText(/2 ventes en attente de synchronisation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Voir' }));

    expect(await screen.findByText('Ventes en attente de synchronisation')).toBeInTheDocument();
    expect(await screen.findByText('Vente 1')).toBeInTheDocument();
  });

  it('l’erreur produits est visible sur TOUS les onglets', () => {
    h.state.productsError = 'boom';
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Caisse' }));
    expect(screen.getByText(/Impossible de charger les produits : boom/)).toBeInTheDocument();
  });

  it('navigue entre les onglets', () => {
    render(<HomePage />);
    expect(screen.getByText('MOD:Dashboard')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Caisse' }));
    expect(screen.getByText('MOD:POS')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dettes' }));
    expect(screen.getByText('MOD:Dettes')).toBeInTheDocument();
  });

  it('pastille « à relancer » sur l’onglet Dettes (plan payant)', async () => {
    h.state.relancer = [{}, {}];
    render(<HomePage />);
    await waitFor(() => {
      const dettes = h.state.navItems.find((i) => i.key === 'debts');
      expect(dettes?.badge).toBe(2);
    });
  });

  it('scanne un produit connu : l’ajoute au panier de la caisse', () => {
    h.state.products = [{ id: 'p1', name: 'Riz', sku: 'RIZ-1' }];
    render(<HomePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Scanner' }));
    fireEvent.click(screen.getByRole('button', { name: 'scan-riz' }));

    // La caisse s'ouvre avec la demande d'ajout portant le produit.
    expect(screen.getByText('MOD:POS:p1')).toBeInTheDocument();
  });

  it('code-barres inconnu : message dans le scanner', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Scanner' }));
    fireEvent.click(screen.getByRole('button', { name: 'scan-x' }));

    expect(screen.getByText(/Aucun produit trouvé pour le code-barres : INCONNU/)).toBeInTheDocument();
  });

  it('ouvre le formulaire produit depuis l’inventaire', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Stock' }));
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(screen.getByText('MOD:FormProduit')).toBeInTheDocument();
  });

  it('ouvre l’import depuis l’inventaire', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Stock' }));
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    expect(screen.getByText('MOD:Import')).toBeInTheDocument();
  });
});
