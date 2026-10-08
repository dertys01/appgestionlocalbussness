/**
 * Décision d'invitation à l'installation (P2), séparée du rendu pour
 * être testable sans navigateur.
 *
 * Règle : on ne propose jamais à quelqu'un qui a déjà installé, ni à
 * quelqu'un qui a refusé. Sinon, le bouton natif (Chrome/Android) prime ;
 * iOS ne connaissant pas `beforeinstallprompt`, on y donne la consigne
 * manuelle de Safari (Partager → Sur l'écran d'accueil).
 */

export type InvitationInstallation =
  | { type: 'aucune' }
  | { type: 'bouton' }
  | { type: 'ios' };

/**
 * Comment l'application est ouverte : 'standalone' (installée depuis le
 * manifeste, plein écran) ou 'navigateur'. C'est la valeur relevée dans
 * `organizations.display_mode` (migration_display_mode.sql) par le
 * SupabaseProvider — le pilote y lit si les commerçants installent
 * réellement l'icône qu'on leur propose (P2 mesuré avec P3).
 *
 * iOS ne joue pas le jeu de `display-mode` : Safari expose sa propre
 * propriété `navigator.standalone`.
 */
export type ModeOuverture = 'standalone' | 'navigateur';

export function modeOuverture(): ModeOuverture {
  if (typeof window === 'undefined') return 'navigateur';
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return 'standalone';
  return 'navigateur';
}

export function invitationARecevoir(contexte: {
  /** Application déjà ouverte en mode installé (standalone). */
  installe: boolean;
  /** `beforeinstallprompt` capturé et non consommé. */
  inviteDisponible: boolean;
  /** iPhone / iPad (Safari, pas de prompt natif). */
  ios: boolean;
  /** L'utilisateur a fermé la bannière. */
  refusee: boolean;
}): InvitationInstallation {
  if (contexte.installe || contexte.refusee) return { type: 'aucune' };
  if (contexte.inviteDisponible) return { type: 'bouton' };
  if (contexte.ios) return { type: 'ios' };
  return { type: 'aucune' };
}
