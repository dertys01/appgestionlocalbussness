import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DashboardTab } from '@/components/dashboard/DashboardTab';
import type { Product } from '@/types';

const product = (over: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    name: 'Riz 1 kg',
    price_sell: 1000,
    stock_qty: 5,
    min_stock_level: 2,
    ...over,
  }) as unknown as Product;

function renderTab(products: Product[], canManageProducts = true) {
  const handlers = {
    onNewSale: vi.fn(),
    onAddProduct: vi.fn(),
    onRestock: vi.fn(),
  };
  render(
    <DashboardTab products={products} canManageProducts={canManageProducts} {...handlers} />
  );
  return handlers;
}

/**
 * Le premier écran d'une boutique neuve est le vrai cas du programme bêta :
 * il se joue à zéro produit, et aucun recette existante ne peut le montrer —
 * les deux comptes de recette ont des données.
 */
describe('DashboardTab — boutique neuve (0 produit)', () => {
  it('remplace les trois cartes à zéro par les trois premiers pas', () => {
    renderTab([]);

    expect(screen.getByText('Bienvenue : vos trois premiers pas')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    // pas de carte « 0 F » sans explication
    expect(screen.queryByText('Valeur stock')).toBeNull();
    expect(screen.queryByText('Stock critique')).toBeNull();
  });

  it('nomme les trois étapes dans l’ordre du métier', () => {
    renderTab([]);

    expect(screen.getByText('Ajoutez vos produits')).toBeInTheDocument();
    expect(screen.getByText('Enregistrez une vente')).toBeInTheDocument();
    expect(screen.getByText('Suivez ce qui reste dû')).toBeInTheDocument();
  });

  it('reste utilisable : les deux actions du premier écran sont là', () => {
    const { onNewSale, onAddProduct } = renderTab([]);

    fireEvent.click(screen.getByRole('button', { name: /Nouvelle vente/ }));
    expect(onNewSale).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Ajouter produit/ }));
    expect(onAddProduct).toHaveBeenCalledTimes(1);
  });

  it('au caissier, ne promet pas un bouton qu’il n’a pas', () => {
    renderTab([], false);

    expect(screen.getByText('Boutique encore vide')).toBeInTheDocument();
    expect(screen.getByText(/Le gérant doit en ajouter/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ajouter produit/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Nouvelle vente/ })).toBeInTheDocument();
  });
});

describe('DashboardTab — chargement initial (zéro produit, catalogue en route)', () => {
  function renderCharge() {
    render(
      <DashboardTab products={[]} loadingProducts canManageProducts onNewSale={vi.fn()}
        onAddProduct={vi.fn()} onRestock={vi.fn()} />
    );
  }

  it('ne dit jamais « Rien n’est enregistré » à une boutique dont on ne sait rien encore', () => {
    renderCharge();
    // La régression vue en recette : après chaque rechargement, le tableau
    // affichait « Bienvenue : vos trois premiers pas » sur une boutique
    // pleine, le temps que le catalogue arrive — une petite page angoissante
    // avant la vraie.
    expect(screen.queryByText(/Bienvenue : vos trois premiers pas/)).toBeNull();
    expect(screen.queryByText(/Rien n’est enregistré/)).toBeNull();
    expect(screen.getByLabelText('Chargement du tableau de bord')).toBeInTheDocument();
  });

  it('les vraies cartes remplacent le chargement à l’arrivée du catalogue', () => {
    const vue = render(
      <DashboardTab products={[]} loadingProducts canManageProducts onNewSale={vi.fn()}
        onAddProduct={vi.fn()} onRestock={vi.fn()} />
    );
    expect(screen.getByLabelText('Chargement du tableau de bord')).toBeInTheDocument();
    vue.rerender(
      <DashboardTab products={[product()]} loadingProducts={false} canManageProducts
        onNewSale={vi.fn()} onAddProduct={vi.fn()} onRestock={vi.fn()} />
    );
    expect(screen.queryByLabelText('Chargement du tableau de bord')).toBeNull();
    expect(screen.getByText(/Encaissé aujourd/)).toBeInTheDocument();
  });
});

describe('DashboardTab — boutique en activité', () => {
  const today = { revenue: 42300, cash: 30000, momo: 12300, sales: 7, debtTotal: 15500, debtClients: 2 };

  it('montre la journée : encaissé, ventes, à recouvrer', () => {
    render(
      <DashboardTab products={[product()]} canManageProducts onNewSale={vi.fn()} onAddProduct={vi.fn()}
        onRestock={vi.fn()} today={today} onOpenDebts={vi.fn()} />
    );
    expect(screen.getByText(/Encaissé aujourd/)).toBeInTheDocument();
    expect(screen.getByText(/42\s?300 F/)).toBeInTheDocument();
    expect(screen.getByText(/Espèces 30\s?000 F · Mobile Money 12\s?300 F/)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText(/15\s?500 F/)).toBeInTheDocument();
    expect(screen.getByText('2 clients')).toBeInTheDocument();
    expect(screen.queryByText(/Bienvenue : vos trois premiers pas/)).toBeNull();
  });

  it('n\u2019affiche pas de faux zéros pendant le chargement', () => {
    renderTab([product()]);
    // « 0 F » encaissé avant la réponse se lirait « vous n'avez rien vendu ».
    expect(screen.queryByText('0 F')).toBeNull();
    expect(screen.getAllByText('…').length).toBeGreaterThan(0);
  });

  it('la carte des dettes ouvre l\u2019écran Dettes', () => {
    const onOpenDebts = vi.fn();
    render(
      <DashboardTab products={[product()]} canManageProducts onNewSale={vi.fn()} onAddProduct={vi.fn()}
        onRestock={vi.fn()} today={today} onOpenDebts={onOpenDebts} />
    );
    fireEvent.click(screen.getByRole('button', { name: /À recouvrer/ }));
    expect(onOpenDebts).toHaveBeenCalledTimes(1);
  });

  it('ne parle de stock bas que s\u2019il y en a, et compte les bons produits', () => {
    const { unmount } = renderTabRendu([product()]);
    expect(screen.queryByText(/Stock bas/)).toBeNull();
    unmount();

    renderTab([
      product(),
      product({ id: 'p2', name: 'Huile 1 L', stock_qty: 1, min_stock_level: 3 }),
      product({ id: 'p3', name: 'Sucre 1 kg', stock_qty: 1, min_stock_level: 3 }),
    ]);
    // les deux produits sous le seuil, jamais « 3 »
    expect(screen.getByText(/Stock bas : 2 produits à réapprovisionner/)).toBeInTheDocument();
    expect(screen.getByText('Huile 1 L')).toBeInTheDocument();
    expect(screen.getByText('Sucre 1 kg')).toBeInTheDocument();
    expect(screen.queryByText('Riz 1 kg')).toBeNull();
  });
});

function renderTabRendu(products: Product[]) {
  return render(
    <DashboardTab products={products} canManageProducts onNewSale={vi.fn()} onAddProduct={vi.fn()} onRestock={vi.fn()} />
  );
}
