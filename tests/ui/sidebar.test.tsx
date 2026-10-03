import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { matchMediaPour } from './setup';
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

function renderSidebar(ouvert = false) {
  const handlers = {
    onTab: vi.fn(),
    onScan: vi.fn(),
    onRefresh: vi.fn(),
    onSignOut: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <Sidebar
      tab="dashboard"
      items={items}
      email={EMAIL}
      loadingProducts={false}
      open={ouvert}
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

/**
 * Tiroir mobile.
 *
 * Le rail de 64 px était en `z-40` et la barre du bas du POS en `z-30` : le
 * rail passait au-dessus et tronquait le total affiché. Il est devenu un
 * tiroir hors écran, ce qui rend en plus au catalogue la largeur d'un quart
 * d'écran.
 */
describe('Sidebar — tiroir mobile', () => {
  it('fermé, il est hors écran et ne montre aucun voile', () => {
    renderSidebar(false);
    const aside = document.querySelector('aside');
    expect(aside?.className).toContain('-translate-x-full');
    expect(screen.queryByRole('button', { name: 'Fermer le menu' })).toBeNull();
  });

  it('ouvert, il est à l\'écran et propose sa fermeture', () => {
    renderSidebar(true);
    const aside = document.querySelector('aside');
    expect(aside?.className).toContain('translate-x-0');
    expect(aside?.className).not.toContain('-translate-x-full');
    expect(screen.getAllByRole('button', { name: 'Fermer le menu' }).length).toBeGreaterThan(0);
  });

  it('le voile ne peut pas refermer un tiroir fermé', () => {
    renderSidebar(false);
    // S'il existait malgré tout, il masquerait tout l'écran sans raison.
    expect(screen.queryByRole('button', { name: 'Fermer le menu' })).toBeNull();
  });

  it('choisir un onglet referme le tiroir, sinon il masque le nouvel écran', () => {
    const { onClose } = renderSidebar(true);
    fireEvent.click(screen.getByRole('button', { name: 'Accueil' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('échap referme le tiroir', () => {
    const { onClose } = renderSidebar(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('échap ne fait rien quand il est déjà fermé', () => {
    const { onClose } = renderSidebar(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('chaque entrée garde son nom accessible, tiroir ouvert', () => {
    renderSidebar(true);
    // Le libellé visible ne doit pas disparaître du nom accessible : c'est
    // toute la raison du aria-label posé au Sprint 5, et le tiroir mobile
    // dépend de lui.
    expect(screen.getByRole('button', { name: 'Accueil' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vente' })).toBeInTheDocument();
  });

  it('fermé sur mobile, le tiroir sort du parcours de tabulation', () => {
    renderSidebar(false);
    // Le aside est alors hors écran : sans inert, le clavier y entrait.
    expect(document.querySelector('aside')?.hasAttribute('inert')).toBe(true);
  });

  it('ouvert, le tiroir redevient accessible', () => {
    renderSidebar(true);
    expect(document.querySelector('aside')?.hasAttribute('inert')).toBe(false);
  });
});

// Le tiroir n'existe que sous 1024 px. Sans basculer la largeur, on testerait
// le rail de grand écran en croyant tester le mobile.
const matchMediaLarge = window.matchMedia;
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true, configurable: true, value: matchMediaPour(375),
  });
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true, configurable: true, value: matchMediaLarge,
  });
});
