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

    expect(screen.getByText('Bienvenue — vos trois premiers pas')).toBeInTheDocument();
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

describe('DashboardTab — boutique en activité', () => {
  it('retrouve les trois cartes dès qu’un produit existe', () => {
    renderTab([product()]);

    expect(screen.getByText('Produits')).toBeInTheDocument();
    expect(screen.getByText('Valeur stock')).toBeInTheDocument();
    expect(screen.getByText('Stock critique')).toBeInTheDocument();
    expect(screen.queryByText(/Bienvenue — vos trois premiers pas/)).toBeNull();
  });

  it('compte le stock critique au-dessus du seuil, pas tous les produits', () => {
    renderTab([
      product(),
      product({ id: 'p2', name: 'Huile 1 L', stock_qty: 1, min_stock_level: 3 }),
      product({ id: 'p3', name: 'Sucre 1 kg', stock_qty: 1, min_stock_level: 3 }),
    ]);

    // les deux produits sous le seuil, jamais « 3 »
    expect(screen.getByText('À réapprovisionner')).toBeInTheDocument();
    expect(screen.getByText('Huile 1 L')).toBeInTheDocument();
    expect(screen.getByText('Sucre 1 kg')).toBeInTheDocument();
    expect(screen.queryByText('Riz 1 kg')).toBeNull();
  });
});
