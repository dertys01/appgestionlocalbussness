/**
 * Règles du rate limiting de src/proxy.ts.
 *
 * Existe en module séparé pour une raison précise : src/proxy.ts importe
 * next/server, que `node --test` ne charge pas. La logique — quel plafond
 * s'applique, et comment lire la valeur renvoyée par bump_rate_limit() — vit
 * ici, et se teste sans le proxy.
 */

export interface RateLimitRule {
  /** Nombre de requêtes autorisées dans la fenêtre. */
  max: number;
  /** Longueur de la fenêtre, en secondes (format de p_window_seconds). */
  windowSeconds: number;
}

/**
 * Écritures : 10 par minute et par couple (IP, chemin).
 *
 * C'est la seule chose qu'on veut freiner — création de compte, invitations,
 * ajout d'employé, parcours Stripe. Tout a un effet de bord comptable ou
 * identitaire, et rien n'en dépend pour s'afficher.
 */
export const WRITE_RULE: RateLimitRule = { max: 10, windowSeconds: 60 };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Le plafond à appliquer, ou `null` pour « aucune limite ».
 *
 * Les lectures passent outre, et c'est volontaire : la console équipe recharge
 * les listes à chaque ouverture de panneau, à chaque invitation créée et à
 * chaque clic sur le rafraîchisseur. Les limiter à 10/min — comme le faisait
 * le compteur mémoire — bloquait un patron qui vérifiait simplement son
 * équipe, sans protéger quoi que ce soit : une lecture n'a aucun effet de bord,
 * et ces routes exigent déjà un jeton valide.
 *
 * `method` est normalisé : la casse d'une en-tête HTTP n'est pas garantie.
 */
export function ruleFor(method: string): RateLimitRule | null {
  return WRITE_METHODS.has(method.trim().toUpperCase()) ? WRITE_RULE : null;
}

/**
 * Interprète la valeur renvoyée par `bump_rate_limit()`.
 *
 * La fonction renvoie `v_count > p_max`, c'est-à-dire **true quand la limite
 * est DÉPASSÉE** — l'inverse d'une API « autorisé ». Dire `return data === true`
 * comme « autorisé » laisserait passer dix appels puis bloquerait le onzième
 * légitime. Tout ce qui n'est pas strictement `true` est réputé autorisé :
 * un JSON absent ou inattendu ne doit pas couper une inscription.
 */
export function isOverLimit(value: unknown): boolean {
  return value === true;
}
