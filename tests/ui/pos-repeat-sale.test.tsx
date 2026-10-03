import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Reprendre la dernière vente.
 *
 * Fonction standard de tout POS du commerce (« repeat last transaction »).
 * Son intérêt ici est concret : un client qui revient pour un second GSM
 * identique, et un caissier qui resélectionne tout à la main.
 *
 * La règle qui compte : ça AJOUTE, ça n'écrase jamais. Un raccourci capable de
 * vider une vente en cours serait plus dangereux que le temps qu'il fait
 * gagner.
 */
const { products, from, rpc, supabase } = vi.hoisted(() => {
  const produits = [
    { id: 'a17-6', name: 'A17 128/6', category: 'smartphones', price_buy: 93000, price_sell: 108000, stock_qty: 10, min_stock_level: 1 },
    { id: 'coque', name: 'Coque A17', category: 'smartphones', price_buy: 2000, price_sell: 3500, stock_qty: 20, min_stock_level: 1 },
    { id: 'riz', name: 'RIZ', category: 'cereal', price_buy: 1200, price_sell: 1500, stock_qty: 5, min_stock_level: 1 },
  ];
  const from = vi.fn();
  const rpc = vi.fn();
  return {
    products: produits,
    from,
    rpc,
    supabase: { from, rpc, auth: { getUser: vi.fn() } },
  };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'pro',
    org: null,
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

/** Chaîne PostgREST chaînable, filtrée par table. */
function chaine(donnees: unknown[] = []) {
  let filtre: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) {
    q[m] = (...args: unknown[]) => {
      if (m === 'eq') filtre = { ...filtre, eq: args[0] };
      if (m === 'limit') filtre = { ...filtre, limit: args[0] };
      return q;
    };
  }
  q.then = (ok: unknown, ko: unknown) =>
    Promise.resolve({ data: donnees, error: null }).then(ok as never, ko as never);
  return q;
}

const VENTE = { id: 'v1', total_amount: 219500 };
const LIGNES = [
  { product_id: 'a17-6', quantity: 2, unit_price: 108000 },
  { product_id: 'coque', quantity: 1, unit_price: 3500 },
];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: [], error: null });
  from.mockImplementation((table: string) => {
    if (table === 'sales') return chaine([VENTE]);
    if (table === 'sale_items') return chaine(LIGNES);
    return chaine([]);
  });
});

const renderPOS = () =>
  render(<POSModule products={products as unknown as Product[]} onSaleComplete={vi.fn()} />);

/**
 * Clique la carte produit de la grille, et non la ligne du panier qui porte le
 * même nom : une fois l'article ajouté, le nom apparaît deux fois.
 */
function ajouterAuPanier(nom: string, fois = 1) {
  for (let i = 0; i < fois; i++) {
    fireEvent.click(screen.getAllByText(nom)[0]);
  }
}

const boutonReprendre = () =>
  screen.getByRole('button', { name: /Ajouter au panier les \d+ articles de la dernière vente/ });

describe('POS — reprendre la dernière vente', () => {
  it('le bouton apparaît avec le nombre d’articles et le total', async () => {
    renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    // 2 A17 + 1 coque = 219 500 F, cohérent avec la vente relue.
    expect(boutonReprendre().textContent).toContain('2 articles');
  });

  it('cliquer ajoute les articles au panier', async () => {
    renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(boutonReprendre());

    // 2 × 108 000 + 3 500 = 219 500, en 3 unités : la barre compte les
    // unités, pas les lignes de panier.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /3 articles, total/ })).toBeInTheDocument()
    );
  });

  it('fusionne avec un panier déjà rempli au lieu de l’écraser', async () => {
    renderPOS();
    // Le caissier a déjà ajouté 3 RIZ.
    ajouterAuPanier('RIZ', 3);
    await waitFor(() => expect(screen.getByRole('button', { name: /3 articles, total/ })).toBeInTheDocument());

    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(boutonReprendre());

    // 3 RIZ + 2 A17 + 1 coque = 6 unités. Si la reprise remplaçait, il en
    // resterait 3 : c'est le test qui protège le panier en cours.
    await waitFor(() => expect(screen.getByRole('button', { name: /6 articles, total/ })).toBeInTheDocument());
  });

  it('ne propose rien quand le catalogue est vide de ventes', async () => {
    from.mockImplementation((table: string) => chaine(table === 'sales' ? [] : []));
    renderPOS();
    await waitFor(() => expect(screen.getByText('RIZ')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /dernière vente/ })).toBeNull();
  });

  it('retire les lignes dont le produit a quitté le catalogue, sans planter', async () => {
    from.mockImplementation((table: string) => {
      if (table === 'sales') return chaine([VENTE]);
      // « disparu » n'est plus au catalogue : la ligne doit être écartée.
      if (table === 'sale_items') {
        return chaine([
          { product_id: 'a17-6', quantity: 1, unit_price: 108000 },
          { product_id: 'disparu', quantity: 4, unit_price: 9000 },
        ]);
      }
      return chaine([]);
    });
    renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    expect(boutonReprendre().textContent).toContain('retiré du catalogue');
    fireEvent.click(boutonReprendre());
    await waitFor(() => expect(screen.getByRole('button', { name: /1 article, total/ })).toBeInTheDocument());
  });

  it('ne peut pas dépasser le stock', async () => {
    // RIZ : stock 5, la dernière vente en prenait 2 et le caissier en a déjà 4.
    from.mockImplementation((table: string) => {
      if (table === 'sales') return chaine([{ id: 'v2', total_amount: 3000 }]);
      if (table === 'sale_items') return chaine([{ product_id: 'riz', quantity: 2, unit_price: 1500 }]);
      return chaine([]);
    });
    renderPOS();
    ajouterAuPanier('RIZ', 4);
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(boutonReprendre());

    // 4 + 2 = 6, mais le stock est de 5 : la ligne s'arrête à 5, sinon c'est
    // create_sale() qui refuse au dernier moment et la vente est perdue.
    await waitFor(() => expect(screen.getByRole('button', { name: /5 articles, total/ })).toBeInTheDocument());
  });
});
