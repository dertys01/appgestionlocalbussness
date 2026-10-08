/**
 * Sélecteur de prestataire Mobile Money.
 *
 * PAYMENTS_PROVIDER (sandbox | fedapay | paydunya) choisit qui crée les
 * paiements et qui vérifie les webhooks — toujours le MÊME pour les deux :
 * un webhook venant d'un prestataire autre que celui configuré est refusé
 * par la route avant même la signature.
 *
 * Défaut « sandbox » : en local et sur un déploiement sans configuration,
 * le parcours existe (commande + page) mais la confirmation reste fermée —
 * elle exige PAYMENTS_SANDBOX=1 en plus, jamais vrai en production. On ne
 * peut donc pas « oublier » la configuration et vendre du faux.
 */

import type { Prestataire } from './types';
import { Sandbox } from './sandbox';
import { FedaPay } from './fedapay';
import { PayDunya } from './paydunya';

const PRESTATAIRES = {
  sandbox: Sandbox,
  fedapay: FedaPay,
  paydunya: PayDunya,
} as const;

export type NomPrestataire = keyof typeof PRESTATAIRES;

/**
 * Instance du prestataire. `nom` explicite pour les routes webhook (le nom
 * vient du segment d'URL) ; sans nom, la configuration de l'environnement.
 * Lance si le nom est inconnu — un nom inventé ne choisit rien.
 */
export function getPrestataire(nom?: string): Prestataire {
  const id = nom ?? process.env.PAYMENTS_PROVIDER ?? 'sandbox';
  const Classe = PRESTATAIRES[id as NomPrestataire];
  if (!Classe) throw new Error(`Passerelle de paiement inconnue : ${id}`);
  return new Classe();
}

export type { Prestataire, DemandePaiement, PaiementCree, Confirmation } from './types';
