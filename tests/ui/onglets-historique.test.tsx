import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useHistoriqueOnglets } from '@/lib/hooks/useHistoriqueOnglets';
import type { Tab } from '@/types';

/**
 * Bouton retour du système (Android, navigateur).
 *
 * Sans ce hook, l'application n'offre qu'une seule entrée d'historique et le
 * retour la ferme — le commerçant sort de l'app au lieu de revenir au
 * tableau de bord ou à l'écran précédent. Chaque onglet pose son entrée ;
 * l'ouverture remplace la première (revenir du premier écran doit sortir).
 *
 * `history.back()` réel n'est pas pilotable en jsdom : on espionne pushState
 * / replaceState et on déclenche `popstate` à la main — c'est exactement ce
 * que le navigateur fait, sans lui.
 */

function Sonde() {
  const [tab, setTab] = useState<Tab>('dashboard');
  useHistoriqueOnglets(tab, setTab);
  return (
    <div>
      <span data-testid="onglet">{tab}</span>
      <button onClick={() => setTab('pos')}>aller caisse</button>
      <button onClick={() => setTab('debts')}>aller dettes</button>
    </div>
  );
}

function retourVers(tab: unknown) {
  // Simulation fidèle : dans un vrai navigateur, `popstate` ne survient QUE
  // parce que l'historique a déjà navigué — history.state porte donc déjà la
  // cible. `replaceState` pose cet état sans empiler (sinon l'espion de
  // `pushState` compterait la simulation elle-même).
  const etat = tab === undefined ? null : { tab };
  window.history.replaceState(etat, '');
  fireEvent(window, new PopStateEvent('popstate', { state: etat }));
}

describe('useHistoriqueOnglets — bouton retour du système', () => {
  it('à l’ouverture, remplace l’entrée (pas d’empilement)', () => {
    const remplacer = vi.spyOn(window.history, 'replaceState');
    render(<Sonde />);
    expect(remplacer).toHaveBeenCalledWith({ tab: 'dashboard' }, '');
    remplacer.mockRestore();
  });

  it('chaque changement d’onglet empile une entrée', () => {
    const empiler = vi.spyOn(window.history, 'pushState');
    render(<Sonde />);
    empiler.mockClear();
    fireEvent.click(screen.getByText('aller caisse'));
    expect(empiler).toHaveBeenCalledWith({ tab: 'pos' }, '');
    fireEvent.click(screen.getByText('aller dettes'));
    expect(empiler).toHaveBeenCalledWith({ tab: 'debts' }, '');
    expect(screen.getByTestId('onglet').textContent).toBe('debts');
    empiler.mockRestore();
  });

  it('le retour arrière revient à l’onglet précédent, sans réempiler', () => {
    const empiler = vi.spyOn(window.history, 'pushState');
    render(<Sonde />);
    fireEvent.click(screen.getByText('aller caisse'));
    empiler.mockClear();
    retourVers('dashboard');
    expect(screen.getByTestId('onglet').textContent).toBe('dashboard');
    // L'entrée courante correspond déjà : aucun push, sinon le retour
    // tournerait en rond sur le même écran.
    expect(empiler).not.toHaveBeenCalled();
    empiler.mockRestore();
  });

  it('un état inconnu ou absent retombe sur le tableau de bord', () => {
    render(<Sonde />);
    fireEvent.click(screen.getByText('aller dettes'));
    expect(screen.getByTestId('onglet').textContent).toBe('debts');
    retourVers('nimporte-quoi');
    expect(screen.getByTestId('onglet').textContent).toBe('dashboard');
    retourVers(undefined);
    expect(screen.getByTestId('onglet').textContent).toBe('dashboard');
  });
});
