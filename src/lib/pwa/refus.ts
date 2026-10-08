/**
 * Mémorisation du refus de la bannière d'installation (P2).
 *
 * On préfère `localStorage` : le refus survit aux visites. S'il est
 * indisponible (navigateur privé, stockage plein, environnement de test),
 * le refus vaut le temps de la session — c'est le composant qui
 * l'applique alors ; il ne faut surtout pas que ce détail fasse planter
 * l'accueil.
 */

const CLE = 'gl:installation-refusee';

export function lireRefus(): boolean {
  try {
    return window.localStorage?.getItem(CLE) === '1';
  } catch {
    return false;
  }
}

export function marquerRefus(): void {
  try {
    window.localStorage?.setItem(CLE, '1');
  } catch {
    /* stockage plein/privé : le refus reste porté par le composant */
  }
}

/**
 * Oublie un refus exprimé. Aucun écran n'appelle cette fonction :
 * c'est le harnais de test qui isole ainsi ses cas.
 */
export function reinitialiserRefus(): void {
  try {
    window.localStorage?.removeItem(CLE);
  } catch {
    /* rien à oublier */
  }
}
