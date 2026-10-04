import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { products, rpc, supabase } = vi.hoisted(() => {
  const produits = [
    { id: 'a17-4', name: 'A17 128/4', category: 'smartphones', price_buy: 84000, price_sell: 99000, stock_qty: 5, min_stock_level: 1 },
    { id: 'a17-6', name: 'A17 128/6', category: 'smartphones', price_buy: 93000, price_sell: 108000, stock_qty: 3, min_stock_level: 1 },
    { id: 'riz', name: 'RIZ', category: 'cereal', price_buy: 1200, price_sell: 1500, stock_qty: 80, min_stock_level: 1 },
    { id: 'hp', name: 'HP 15 core i7', category: 'laptop', price_buy: 300000, price_sell: 350000, stock_qty: 4, min_stock_level: 1 },
    { id: 'sam', name: 'Samsung A26 128/8', category: 'smartphones', price_buy: 143000, price_sell: 168000, stock_qty: 6, min_stock_level: 1 },
    { id: 'rupture', name: 'Rupture test', category: 'laptop', price_buy: 1000, price_sell: 2000, stock_qty: 0, min_stock_level: 1 },
    { id: 'archive', name: 'Article archivé', category: 'laptop', price_buy: 1000, price_sell: 2000, stock_qty: 5, min_stock_level: 1, is_active: false },
  ];
  const rpc = vi.fn();
  return { products: produits, rpc, supabase: { from: vi.fn(), rpc, auth: { getUser: vi.fn() } } };
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

/**
 * Trouver un article sans parcourir le catalogue.
 *
 * Le cas réel du maintien : « 1000 articles, difficile de les sélectionner un
 * à un ». La réponse n'est pas de scrolls plus vite, c'est de ne plus avoir à
 * chercher : faute de frappe tolérée, variante trouvable par son nombre,
 * catégorie en un geste, et les + vendus en tête.
 */
const CATALOGUE = products as unknown as Product[];

function renderPOS() {
  return render(<POSModule products={CATALOGUE} onSaleComplete={vi.fn()} />);
}

const champRecherche = () => screen.getByLabelText(/Rechercher un produit/);

beforeEach(() => {
  vi.clearAllMocks();
  // Par défaut, aucun classement : le plan gratuit échoue, la recherche doit
  // fonctionner malgré tout.
  rpc.mockResolvedValue({ data: [], error: null });
});

describe('POS — la recherche trouve ce qu’on tape', () => {
  it('la faute de frappe ne renvoie pas « aucun résultat »', async () => {
    renderPOS();
    fireEvent.change(champRecherche(), { target: { value: 'samsng' } });
    // Aucun produit ne s'appelle « samsng » : c'est le cas qui doit quand même
    // remonter quelque chose, sinon le caissier conclut à une rupture.
    await waitFor(() => expect(screen.getByText('Samsung A26 128/8')).toBeInTheDocument());
  });

  it('la faute reste tolérée dans une saisie à plusieurs mots', async () => {
    // « samsng a26 » doit trouver l'A26 : sinon la tolérance disparaît dès que
    // la saisie se compose, ce qui est le cas normal.
    renderPOS();
    fireEvent.change(champRecherche(), { target: { value: 'samsng a26' } });
    await waitFor(() => expect(screen.getByText('Samsung A26 128/8')).toBeInTheDocument());
  });

  it('« 128/6 » trouve la bonne variante, pas 128/4', async () => {
    renderPOS();
    fireEvent.change(champRecherche(), { target: { value: '128/6' } });
    await waitFor(() => expect(screen.getByText('A17 128/6')).toBeInTheDocument());
    expect(screen.queryByText('A17 128/4')).toBeNull();
  });

  it('le prix saisi trouve l’article', async () => {
    renderPOS();
    fireEvent.change(champRecherche(), { target: { value: '1500' } });
    await waitFor(() => expect(screen.getByText('RIZ')).toBeInTheDocument());
  });
});

describe('POS — les articles cachés à la caisse', () => {
  // Un article ARCHIVÉ a disparu de la vente : il n'a plus à être proposé, et
  // le chercher ne doit pas le faire revenir.
  it('ne propose jamais un article archivé', () => {
    renderPOS();
    expect(screen.queryByText('Article archivé')).toBeNull();
  });

  // Un article EN RUPTURE, lui, reste visible et marqué. C'est le premier écart
  // avec les caisses du commerce : un client demande de l'huile, le caissier
  // tape « huile », et l'écran ne disait rien. Impossible alors de distinguer
  // « il n'y en a plus » de « on n'en vend pas » — deux réponses opposées au
  // client, et une impression d'erreur dans le logiciel.
  it('garde l’article en rupture visible, marqué', () => {
    renderPOS();
    expect(screen.getByText('Rupture test')).toBeInTheDocument();
    expect(screen.getAllByText('Rupture de stock').length).toBeGreaterThan(0);
  });

  it('un article en rupture ne se met pas au panier', () => {
    renderPOS();
    fireEvent.click(screen.getByText('Rupture test'));
    // Le message est celui du scanner : même situation, même réponse.
    expect(screen.getByText(/est en rupture de stock/)).toBeInTheDocument();
    // Et rien n'a été ajouté : le total reste celui d'un panier vide.
    expect(screen.getByRole('button', { name: /Panier vide/ })).toBeInTheDocument();
  });

  it('la recherche le trouve aussi', async () => {
    renderPOS();
    fireEvent.change(champRecherche(), { target: { value: 'rupture' } });
    await waitFor(() => expect(screen.getByText('Rupture test')).toBeInTheDocument());
  });
});

describe('POS — la barre de catégories', () => {
  it('filtre sur une catégorie', async () => {
    renderPOS();
    fireEvent.click(screen.getByRole('button', { name: 'cereal' }));

    await waitFor(() => expect(screen.getByText('RIZ')).toBeInTheDocument());
    expect(screen.queryByText('A17 128/4')).toBeNull();
  });

  it('« Tous » revient au catalogue entier', async () => {
    renderPOS();
    fireEvent.click(screen.getByRole('button', { name: 'cereal' }));
    await waitFor(() => expect(screen.queryByText('A17 128/4')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Tous' }));
    await waitFor(() => expect(screen.getByText('A17 128/4')).toBeInTheDocument());
  });

  it('la recherche traverse le filtre : un filtre ne doit pas créer d’impasse', async () => {
    // Chercher « a17 » alors qu'on filtre sur « laptop » ne doit pas
    // disparaître : le caissier ne comprendrait pas pourquoi.
    renderPOS();
    fireEvent.click(screen.getByRole('button', { name: 'cereal' }));
    await waitFor(() => expect(screen.queryByText('A17 128/4')).toBeNull());
    fireEvent.change(champRecherche(), { target: { value: 'a17' } });
    await waitFor(() => expect(screen.getByText('A17 128/4')).toBeInTheDocument());
  });

  it('marque la catégorie retenue comme enfoncée', async () => {
    renderPOS();
    const bouton = screen.getByRole('button', { name: 'cereal' });
    fireEvent.click(bouton);
    await waitFor(() => expect(bouton).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('POS — les + vendus remontent en tête', () => {
  it('classe par quantité vendue quand le plan les donne', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'get_units_sold_since'
          ? { data: [{ product_id: 'riz', quantity: 90 }, { product_id: 'a17-4', quantity: 2 }], error: null }
          : { data: {}, error: null },
      ),
    );
    renderPOS();
    // RIZ, vendu 90 fois, doit passer devant A17 vendu 2 fois.
    await waitFor(() => {
      const noms = screen.getAllByRole('button').map((b) => b.textContent ?? '');
      expect(noms.findIndex((t) => t.includes('RIZ'))).toBeLessThan(
        noms.findIndex((t) => t.includes('A17 128/4')),
      );
    });
  });

  it('un plan sans droit ne provoque ni erreur ni écran vide', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'get_units_sold_since'
          ? { data: null, error: { message: '/plan starter/' } }
          : { data: {}, error: null },
      ),
    );
    renderPOS();
    // Le catalogue reste là, et rien n'annonce un échec : un classement absent
    // n'est pas une panne.
    await waitFor(() => expect(screen.getByText('A17 128/4')).toBeInTheDocument());
    expect(screen.queryByText(/plan/i)).toBeNull();
  });
});

describe('POS — taper une lettre va dans la recherche', () => {
  it('le geste unique place le curseur dans le champ', async () => {
    renderPOS();
    expect(document.activeElement).not.toBe(champRecherche());
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(document.activeElement).toBe(champRecherche()));
  });

  it('ne vole pas la frappe quand on tape déjà dans un champ', async () => {
    renderPOS();
    const autre = document.createElement('input');
    document.body.appendChild(autre);
    autre.focus();
    fireEvent.keyDown(autre, { key: 'b' });
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).toBe(autre);
    autre.remove();
  });

  it('ignore les touches de modification', async () => {
    renderPOS();
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(document.activeElement).not.toBe(champRecherche());
  });
});
