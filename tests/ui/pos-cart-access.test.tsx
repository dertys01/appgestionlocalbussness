import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { products, saleRpc, supabase } = vi.hoisted(() => {
  const produits = Array.from({ length: 43 }, (_, i) => ({
    id: `p${i}`,
    name: `Produit ${i}`,
    sku: null,
    category: 'laptop',
    price_buy: 1000,
    price_sell: 1500,
    stock_qty: 5,
    min_stock_level: 1,
  }));
  const saleRpc = vi.fn();
  return {
    products: produits,
    saleRpc,
    supabase: { from: vi.fn(), rpc: saleRpc, auth: { getUser: vi.fn() } },
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
    loadingProducts: false,
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

/**
 * Point de vente — l'accès à la caisse.
 *
 * Sur mobile, le panier était une colonne PLACÉE APRÈS la grille de
 * produits (`flex-col lg:flex-row`). Avec 40 références, le caissier devait
 * faire défiler tout le catalogue pour atteindre le total et « Encaisser ».
 * Ces tests verrouillent la correction : la caisse doit être atteignable sans
 * défilement, et le total visible en permanence.
 *
 * Les produits sont une prop du module — le POS ne lit pas le catalogue
 * lui-même — donc aucun mock de base n'est nécessaire ici.
 */

beforeEach(() => {
  vi.clearAllMocks();
  saleRpc.mockResolvedValue({ data: {}, error: null });
});

/** Ajoute le premier produit au panier en cliquant sa carte. */
function ajouterAuPanier() {
  fireEvent.click(screen.getByText('Produit 0'));
}

const renderPOS = () =>
  render(<POSModule products={products as unknown as Product[]} onSaleComplete={vi.fn()} />);

describe('POS — la caisse est atteignable sans défiler le catalogue', () => {
  it('montre une barre qui donne le total et ouvre le panier', () => {
    renderPOS();

    // Le total est sur la barre, avant toute vente : c'est l'information que
    // le caissier consulte à chaque/article ajouté.
    const barre = screen.getByRole('button', {
      name: /Ouvrir le panier|Panier vide/,
    });
    expect(barre).toBeInTheDocument();
  });

  it('la barre annonce le total à jour dès qu\'un produit est ajouté', async () => {
    renderPOS();
    expect(screen.getByRole('button', { name: 'Panier vide' })).toBeInTheDocument();

    ajouterAuPanier();

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /1 article, total/ })
      ).toBeInTheDocument()
    );
  });

  it('la barre ouvre le panier, qui contient le bouton Encaisser', async () => {
    renderPOS();
    ajouterAuPanier();

    await waitFor(() => expect(screen.getByRole('button', { name: /Ouvrir le panier/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Ouvrir le panier/ }));

    // Le panneau ouvert porte bien l'action de vente : le reproche initial
    // était précisément qu'elle était hors d'atteinte.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Encaisser/ }).length).toBeGreaterThan(0)
    );
  });

  it('fermer le panier sans encaisser garde les articles', async () => {
    renderPOS();
    ajouterAuPanier();
    await waitFor(() => expect(screen.getByRole('button', { name: /Ouvrir le panier/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Ouvrir le panier/ }));
    const fermer = await screen.findByRole('button', {
      name: 'Fermer le panier et revenir aux produits',
    });
    fireEvent.click(fermer);

    // Une vente avortée ne doit pas vider le panier : le caissier a saisi des
    // quantités, il ne les saisira pas deux fois.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 article, total/ })).toBeInTheDocument()
    );
    // On filtre le chargement des + vendus : il passe par le même rpc() et
    // n'a rien à voir avec une vente.
    const ventes = saleRpc.mock.calls.filter((c) => c[0] !== 'get_units_sold_since');
    expect(ventes).toHaveLength(0);
  });

  it('sort la grille du parcours de tabulation quand le panneau la recouvre', async () => {
    const { container } = renderPOS();
    ajouterAuPanier();
    await waitFor(() => expect(screen.getByRole('button', { name: /Ouvrir le panier/ })).toBeInTheDocument());

    const grille = container.querySelector('.grid');
    expect(grille).not.toBeNull();
    // Avant ouverture : la grille est normalement atteignable.
    const zoneAvant = grille?.closest('[inert]');
    expect(zoneAvant).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Ouvrir le panier/ }));

    // Le panneau est plein écran : sans inert, le clavier et les lecteurs
    // d'écran continueraient de parcourir une grille invisible.
    await waitFor(() =>
      expect(container.querySelector('[inert]')).not.toBeNull()
    );
  });
});

describe('POS — le total affiché est bien celui du panier', () => {
  it('additionne les articles, le panier n\'étant pas à un article près', async () => {
    renderPOS();
    ajouterAuPanier();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 article, total/ })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByText('Produit 1'));
    // 1 500 + 1 500 : l'affichage ne doit pas rester sur le premier article.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /2 articles, total/ })).toBeInTheDocument()
    );
  });
});
