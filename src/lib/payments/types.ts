/**
 * Contrat commun aux prestataires de paiement Mobile Money.
 *
 * Sprint 19 : seul le bac à sable local est implémenté. FedaPay et PayDunya
 * existent en squelette — même forme, mêmes méthodes — pour que la route de
 * commande et la route webhook n'aient JAMAIS à changer de structure quand
 * les clés arriveront : on branche un prestataire, on ne réécrit pas le
 * parcours.
 *
 * Une seule règle tient tout l'édifice : un prestataire qui n'est pas
 * branché ÉCHOUE BRUYAMMENT (création qui refuse, callback qui retourne
 * null). Jamais de parcours cassé en silence, jamais de callback accepté
 * par défaut.
 */

import type { PlanPayant, DureePeriode } from '@/lib/utils/plans';

/** Ce qu'une commande dit au prestataire pour naître. */
export interface DemandePaiement {
  /** Jeton unique généré côté serveur — c'est ce que le prestataire
   * renverra dans son webhook pour retrouver la commande. */
  reference: string;
  plan: PlanPayant;
  mois: DureePeriode;
  /** Montant en FCFA, recalculé depuis la configuration de prix en base de
   * route — jamais reçu du navigateur. */
  montant: number;
}

export interface PaiementCree {
  /** Identifiant de la transaction chez le prestataire (fictif au bac à sable). */
  providerRef: string;
  /** Où envoyer le·la commerçant·e pour payer. */
  redirectUrl: string;
}

/** Résultat d'un webhook vérifié : la commande concernée, ou refus net. */
export interface Confirmation {
  reference: string;
  ok: boolean;
}

export interface Prestataire {
  readonly id: 'sandbox' | 'fedapay' | 'paydunya';

  /**
   * Ouvre la page de paiement.
   * N'a fait — et ne fera dans ce sprint — AUCUN appel réseau.
   * Rejette si le prestataire n'est pas branché ou pas autorisé.
   */
  creerPaiement(demande: DemandePaiement): Promise<PaiementCree>;

  /**
   * Vérifie le webhook du prestataire et en extrait la référence.
   * `null` = refus (signature absente/incorrecte, prestataire non branché) :
   * la route répond erreur et n'active RIEN. Fail closed, toujours.
   */
  verifierCallback(corps: string, enTetes: Headers): Confirmation | null;
}
