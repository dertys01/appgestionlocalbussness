import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForecastModule, lienFournisseur } from '@/components/forecast/ForecastModule';

/**
 * Prévisions de réapprovisionnement (Pro) — lot honnêteté + gestes.
 *
 * Ce que ces tests verrouillent :
 *   1. le compteur « Stock suffisant » ne mélange plus « tout va bien » et
 *      « on ne sait pas » (les sans-données en sont exclus) ;
 *   2. les produits archivés ne polluent ni les seaux ni les compteurs ;
 *   3. le stock à zéro qui se vend crie « En rupture » et compte en urgent ;
 *   4. le lien fournisseur est prérempli (produit + quantité, indicatif 229
 *      pour un numéro à 10 chiffres) ;
 *   5. le bouton de réassort pré-remplit la quantité suggérée ;
 *   6. le total de remise à niveau est affiché (trésorerie).
 */

const { supabase, from, rpc } = vi.hoisted(() => {
  const from = vi.fn();
  const rpc = vi.fn();
  return { supabase: { from, rpc }, from, rpc };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

const ligne = (over: Record<string, unknown>) => ({
  id: 'x',
  name: 'X',
  category: null,
  price_buy: 1000,
  price_sell: 1500,
  stock_qty: 10,
  min_stock_level: 1,
  unit: 'pce',
  is_active: true,
  supplier_id: null,
  supplier_name: null,
  supplier_phone: null,
  ...over,
});

const CATALOGUE = [
  ligne({ id: 'riz', name: 'Riz', stock_qty: 2, price_buy: 1000, supplier_name: 'Grossiste', supplier_phone: '0197000001' }),
  ligne({ id: 'huile', name: 'Huile', stock_qty: 10, price_buy: 500 }),
  ligne({ id: 'savon', name: 'Savon', stock_qty: 100 }),
  ligne({ id: 'the', name: 'Thé', stock_qty: 5 }),
  ligne({ id: 'vieux', name: 'Vieux', stock_qty: 1, is_active: false }),
  ligne({ id: 'sel', name: 'Sel', stock_qty: 0, price_buy: 200 }),
];

const VENTES = [
  { product_id: 'riz', quantity: 30 },
  { product_id: 'huile', quantity: 30 },
  { product_id: 'savon', quantity: 30 },
  { product_id: 'vieux', quantity: 30 },
  { product_id: 'sel', quantity: 30 },
];

/** Chaîne PostgREST minimale : select().order() résout les données. */
function chaine(donnees: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.order = () => q;
  q.then = (ok: unknown) =>
    Promise.resolve({ data: donnees, error: null }).then(ok as never);
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation((table: string) =>
    chaine(table === 'products_with_supplier' ? CATALOGUE : []),
  );
  rpc.mockImplementation((fn: string) =>
    Promise.resolve({ data: fn === 'get_units_sold_since' ? VENTES : [], error: null }),
  );
});

const renderModule = () => render(<ForecastModule onRestock={vi.fn()} />);

describe('Prévisions — compteurs honnêtes', () => {
  it('« Stock suffisant » exclut les sans-données ; l’archivé est invisible', async () => {
    const { container } = renderModule();
    await waitFor(() => expect(screen.getByText('Stock suffisant')).toBeInTheDocument());
    const cartes = container.querySelectorAll('.grid.grid-cols-3 > div');
    // Urgent : Riz (2j) + Sel (rupture) = 2 · Attention : Huile = 1 ·
    // Suffisant : Savon seul = 1 (Thé, sans données, exclu).
    expect(cartes[0].textContent).toContain('2');
    expect(cartes[1].textContent).toContain('1');
    expect(cartes[2].textContent).toContain('1');
    expect(screen.getByText('Aucune vente récente')).toBeInTheDocument();
    expect(screen.queryByText('Vieux')).toBeNull();
  });

  it('le stock à zéro qui se vend crie « En rupture »', async () => {
    renderModule();
    expect(await screen.findByText('En rupture, à commander')).toBeInTheDocument();
  });

  it('le total de remise à niveau répond à la question trésorerie', async () => {
    renderModule();
    // Riz : 30 − 2 = 28 × 1000 = 28 000 · Huile : 30 − 10 = 20 × 500 = 10 000
    // Sel : 30 − 0 = 30 × 200 = 6 000 → 44 000 F, 3 articles.
    expect(await screen.findByText(/Pour tout remettre à niveau/)).toBeInTheDocument();
    expect(screen.getByText(/44\s?000 F/)).toBeInTheDocument();
    expect(screen.getByText(/\(3 articles\)/)).toBeInTheDocument();
  });
});

describe('Prévisions — gestes B2B', () => {
  it('le lien fournisseur est prérempli, indicatif compris', async () => {
    renderModule();
    const lien = await screen.findByRole('link', { name: /Commander/ });
    const href = lien.getAttribute('href') ?? '';
    expect(href).toMatch(/^https:\/\/wa\.me\/2290197000001\?text=/);
    const message = decodeURIComponent(href.split('?text=')[1]);
    expect(message).toContain('28');
    expect(message).toContain('Riz');
  });

  it('le réassort pré-remplit la quantité suggérée', async () => {
    renderModule();
    fireEvent.click(await screen.findByRole('button', { name: 'Réapprovisionner Riz' }));
    // Riz : 30/jour-pour-30j − 2 en stock = 28, à valider d'un geste.
    expect(await screen.findByDisplayValue('28')).toBeInTheDocument();
  });
});

describe('lienFournisseur — message', () => {
  it('nomme le produit et la quantité, « pièces » en toutes lettres', () => {
    const href = lienFournisseur('97000001', 'Grossiste', 'Riz', 28, 'pce');
    expect(href).toMatch(/^https:\/\/wa\.me\/22997000001\?text=/);
    expect(decodeURIComponent(href)).toContain('28 pièces de Riz');
  });

  it('singulier à 1, unité technique telle quelle sinon', () => {
    expect(decodeURIComponent(lienFournisseur('97000001', 'G', 'Riz', 1, 'pce')))
      .toContain('1 pièce de Riz');
    expect(decodeURIComponent(lienFournisseur('97000001', 'G', 'Riz', 2.5, 'kg')))
      .toContain('2.5 kg de Riz');
  });

  it('sans quantité suggérée : lien nu, pas de message vide', () => {
    expect(lienFournisseur('97000001', 'G', 'Riz', 0, 'pce'))
      .toBe('https://wa.me/22997000001');
  });
});
