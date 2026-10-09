/**
 * Verrou de délivrance de la facture normalisée (e-MECeF, DGI du Bénin).
 *
 * Décision produit : tant qu'une boutique n'a pas enregistré son IFU et que
 * la connexion au service de facturation n'est pas ouverte, elle ne peut
 * PAS délivrer de facture — seul le reçu simple reste disponible. Le but
 * est de pousser le commerce informel vers la comptabilité numérique :
 * le carnet ne produit pas de facture normalisée, et l'application non
 * plus tant que le lien fiscal n'existe pas.
 *
 * Ce module est PUR (aucun accès réseau, aucune variable d'environnement) :
 * la caisse et l'écran Paramètres posent exactement la même question, et le
 * test la même matrice, sans serveur. Le statut de la connexion, lui, vit
 * côté serveur (MECEF_TOKEN) et arrive par /api/mecef/status.
 */

/** Verdict affichable tel quel sous le reçu ou dans les Paramètres. */
export interface VerdictFacture {
  delivrable: boolean;
  /** Phrase expliquant le verrou, null quand la facture est délivrable. */
  motif: string | null;
}

/**
 * Vérifie une forme d'IFU.
 *
 * L'IFU béninois fait 13 caractères, chiffres ou lettres (format DGI).
 * Une valeur non conforme ne bloque jamais l'enregistrement de la boutique
 * ailleurs : elle empêche seulement la délivrance des factures, et le
 * message renvoie l'utilisateur vers le champ concerné.
 */
export function ifuValide(ifu: string | null | undefined): boolean {
  return /^[A-Za-z0-9]{13}$/.test((ifu ?? '').trim());
}

/**
 * Le verrou, dans l'ordre où la caisse doit le raconter :
 *
 *   1. pas de numéro attribué (plan non Pro) → la facture n'existe pas ;
 *   2. IFU absent ou invalide → c'est au·à la commerçant·e d'agir ;
 *   3. connexion DGI pas encore ouverte → c'est l'activation par nos soins.
 *
 * Le reçu simple, lui, n'est jamais concerné : ce verdict ne porte que sur
 * la délivrance d'une facture normalisée.
 */
export function peutDelivrerFacture(etat: {
  /** Numéro attribué par create_sale (null hors plan Pro). */
  numero: string | null;
  /** IFU enregistré dans les Paramètres > Boutique. */
  ifu: string | null;
  /** Connexion e-MECeF ouverte sur ce déploiement (statut serveur). */
  connexion: boolean;
}): VerdictFacture {
  if (!etat.numero) {
    return { delivrable: false, motif: 'Facture normalisée (Plan Pro uniquement)' };
  }
  if (!ifuValide(etat.ifu)) {
    return {
      delivrable: false,
      motif: 'Renseignez votre IFU (13 caractères) dans Paramètres > Boutique pour délivrer une facture.',
    };
  }
  if (!etat.connexion) {
    return {
      delivrable: false,
      motif:
        "La connexion au service de facturation n'est pas encore ouverte : " +
        'la facture sera délivrable dès son activation. Votre reçu reste disponible.',
    };
  }
  return { delivrable: true, motif: null };
}
