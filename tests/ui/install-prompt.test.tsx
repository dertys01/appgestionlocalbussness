import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';
import { consommerInvite } from '@/lib/pwa/invite';
import { reinitialiserRefus } from '@/lib/pwa/refus';
import { matchMediaPour } from './setup';

/**
 * P2 — la bannière d'installation sur l'accueil du commerçant.
 *
 * Le stub par défaut du setup simule un grand écran (donc déjà installé
 * en apparence) : chaque test dit explicitement s'il joue un téléphone
 * dans le navigateur (767 px, hors standalone) ou une app installée.
 *
 * jsdom n'ayant pas de `localStorage`, le module de refus est simulé en
 * mémoire : c'est bien la persistance du refus qu'on veut vérifier.
 */

vi.mock('@/lib/pwa/refus', () => {
  let refuse = false;
  return {
    lireRefus: () => refuse,
    marquerRefus: () => {
      refuse = true;
    },
    reinitialiserRefus: () => {
      refuse = false;
    },
  };
});

function fixerLargeur(largeur: number) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: matchMediaPour(largeur),
  });
}

/** Émet l'invitation native Chrome avec un prompt espion. */
function emettreInvitation() {
  const event = new Event('beforeinstallprompt');
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(event, 'prompt', { value: prompt });
  Object.defineProperty(event, 'userChoice', {
    value: Promise.resolve({ outcome: 'accepted' }),
  });
  window.dispatchEvent(event);
  return prompt;
}

beforeEach(() => {
  reinitialiserRefus();
});

afterEach(() => {
  consommerInvite(); // rien ne doit fuiter d'un test à l'autre
  fixerLargeur(1440);
  vi.restoreAllMocks();
});

describe('InstallPrompt', () => {
  it('ne dit rien quand l’application est déjà installée', () => {
    fixerLargeur(1440); // le stub donne standalone = vrai
    emettreInvitation();
    const { container } = render(<InstallPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('propose le bouton Android puis appelle le prompt natif', async () => {
    fixerLargeur(767); // téléphone, dans le navigateur : pas standalone
    const { container } = render(<InstallPrompt />);
    const prompt = emettreInvitation();

    const bouton = await screen.findByRole('button', { name: 'Installer' });
    fireEvent.click(bouton);

    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('ne repropose plus la bannière après un refus, même après un nouveau rendu', async () => {
    fixerLargeur(767);
    const vue = render(<InstallPrompt />);
    emettreInvitation();
    await screen.findByRole('button', { name: 'Installer' });

    fireEvent.click(screen.getByRole('button', { name: 'Masquer cette invitation' }));
    expect(vue.container).toBeEmptyDOMElement();

    vue.unmount();
    render(<InstallPrompt />); // retour sur l'accueil : le refus tient
    expect(screen.queryByRole('button', { name: 'Installer' })).toBeNull();
  });
});
