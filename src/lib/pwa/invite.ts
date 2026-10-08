'use client';

/**
 * Capture de l'événement `beforeinstallprompt` (Chrome/Android).
 *
 * Le navigateur ne l'émet qu'une fois par chargement de page : on écoute
 * dès la lecture du module — monté dans le layout — plutôt qu'au montage
 * du composant qui affiche le bouton, sinon on rate l'événement.
 */

/** Invitation native à installer, absente des types TypeScript du DOM. */
export interface InviteInstall {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let invite: InviteInstall | null = null;
const ecouteurs = new Set<() => void>();

function prevenir() {
  ecouteurs.forEach((f) => f());
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // On retient l'événement au lieu de laisser le navigateur ouvrir sa
    // propre bulle : le commerçant choisit depuis l'interface, avec le
    // contexte (et il peut refuser proprement).
    event.preventDefault();
    invite = event as unknown as InviteInstall;
    prevenir();
  });
  window.addEventListener('appinstalled', () => {
    invite = null;
    prevenir();
  });
}

/** L'invitation en attente, ou null. */
export function lireInvite(): InviteInstall | null {
  return invite;
}

/**
 * Retire l'invitation du module et la rend : appelée au clic sur
 * « Installer ». Une fois consommée, elle ne revient pas de la session —
 * si le commerçant a refusé le prompt natif, on n'insiste pas.
 */
export function consommerInvite(): InviteInstall | null {
  const actuelle = invite;
  invite = null;
  prevenir();
  return actuelle;
}

/** Abonne un composant aux changements ; rend le désabonnement. */
export function souscrireInvite(f: () => void): () => void {
  ecouteurs.add(f);
  return () => {
    ecouteurs.delete(f);
  };
}
