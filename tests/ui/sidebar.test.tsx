import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LayoutDashboard, ShoppingCart } from 'lucide-react';

import { Sidebar } from '@/components/layout/Sidebar';
import type { NavItem } from '@/types';

/**
 * Sidebar — le rail de navigation.
 *
 * Ce qui est couvert ici :
 *  - le nom accessible de chaque entrée, qui est la seule chose que reçoit un
 *    utilisateur de rail d'icônes (les libellés sont en `hidden lg:`) ;
 *  - le verrou de plan, qui redirige vers Paramètres ;
 *  - l'identité du compte, visible sur mobile sous forme de pastille.
 */
const EMAIL = 'dertys01@gmail.com';

const items: NavItem[] = [
  { key: 'dashboard', label: 'Accueil', icon: LayoutDashboard, locked: false },
  { key: 'pos', label: 'Vente', icon: ShoppingCart, locked: true },
];

function renderSidebar() {
  const handlers = {
    onTab: vi.fn(),
    onScan: vi.fn(),
    onRefresh: vi.fn(),
    onSignOut: vi.fn(),
  };
  render(
    <Sidebar
      tab="dashboard"
      items={items}
      email={EMAIL}
      loadingProducts={false}
      {...handlers}
    />
  );
  return handlers;
}

describe('Sidebar', () => {
  it('expose chaque entrée sous un nom accessible égal à son libellé', () => {
    renderSidebar();

    expect(screen.getByRole('button', { name: 'Accueil' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vente' })).toBeInTheDocument();
  });

  it('n’ajoute le cadenas que sur une entrée verrouillée', () => {
    renderSidebar();

    const verrouillee = screen.getByRole('button', { name: 'Vente' });
    const libre = screen.getByRole('button', { name: 'Accueil' });

    expect(verrouillee.querySelector('svg.lucide-lock')).not.toBeNull();
    expect(libre.querySelector('svg.lucide-lock')).toBeNull();
  });

  it('envoie vers le bon onglet quand l’entrée est déverrouillée', () => {
    const { onTab } = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Accueil' }));

    expect(onTab).toHaveBeenCalledTimes(1);
    expect(onTab).toHaveBeenCalledWith('dashboard');
  });

  it('redirige vers Paramètres quand l’entrée est verrouillée', () => {
    const { onTab } = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Vente' }));

    expect(onTab).toHaveBeenCalledWith('settings');
    expect(onTab).not.toHaveBeenCalledWith('pos');
  });

  it('donne au rail d’icônes l’identité du compte, masquée à partir de lg', () => {
    renderSidebar();

    // pastille : rôle img + libellé = l'e-mail, seul repère sous lg
    const pastille = screen.getByRole('img', { name: EMAIL });
    expect(pastille.className).toMatch(/lg:hidden/);
    expect(pastille.textContent).toBe('D');

    // e-mail complet : présent dans le DOM, masqué sous lg
    const complet = screen.getByText(EMAIL);
    expect(complet.className).toMatch(/hidden lg:block/);
  });

  it('propose les actions du pied de page avec un nom accessible', () => {
    const { onSignOut, onScan } = renderSidebar();

    expect(screen.getByRole('button', { name: 'Paramètres' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scanner' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actualiser' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Déconnexion' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Scanner' }));
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});
