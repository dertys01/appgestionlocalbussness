/**
 * e-MECeF — machine électronique de facturation certifiée (DGI du Bénin).
 *
 * Modèle, tel qu'il est décidé et ne bougera plus :
 *   • l'application joue le rôle de SFE (système de facturation électronique)
 *     pour la boutique : c'est elle qui émet et transmet les factures ;
 *   • le lien avec la DGI exige un jeton délivré après agrément, qui vit
 *     ICI, côté serveur, dans MECEF_TOKEN — jamais dans le dépôt, jamais
 *     dans le navigateur, comme les clés de paiement ;
 *   • la caisse n'offre la délivrance d'une facture que si l'IFU est
 *     enregistré ET si cette connexion est ouverte (voir ./gate.ts).
 *
 * Comme FedaPay et PayDunya au Sprint 19 : squelette qui REFUSE, sans
 * aucun appel réseau, tant que la DGI n'a pas délivré les accès. Tant que
 * `emettreFacture` rejette, la caisse affiche le verrou (motif de
 * connexion) et le reçu simple reste le seul papier imprimé — on vend
 * explicitement « pas encore », jamais une facture qui n'arriverait
 * nulle part.
 */

/** État de la connexion à la DGI, tel que vu par le serveur. */
export interface EtatLiaison {
  branche: boolean;
  /** Raison du verrou, pour les logs serveur (jamais pour le navigateur). */
  motif: string;
}

/**
 * Le jeton DGI est la moitié du lien : l'autre moitié est la ligne d'appel
 * elle-même, encore à écrire. Comme PAYMENTS_SANDBOX, on ne peut pas
 * « oublier » la configuration et ouvrir la délivrance : il faudra passer
 * cette constante à true dans le même commit que les appels réels.
 */
const APPELS_DGI = false;

/**
 * État de la connexion, pour /api/mecef/status.
 *
 * Seul un booléen sortira vers le navigateur : le motif parle de jeton et
 * d'appels, c'est de la diagnostique serveur.
 */
export function etatLiaison(
  env: NodeJS.ProcessEnv | { MECEF_TOKEN?: string } = process.env,
): EtatLiaison {
  if (!APPELS_DGI) {
    return { branche: false, motif: 'Appels DGI non branchés (accès en attente)' };
  }
  if (!env.MECEF_TOKEN?.trim()) {
    return { branche: false, motif: 'MECEF_TOKEN absent' };
  }
  return { branche: true, motif: '' };
}

/** Données d'une facture à transmettre à la DGI. */
export interface FactureAEmettre {
  numero: string;
  orgId: string;
  ifu: string;
  total: number;
}

/**
 * Émission d'une facture normalisée. Squelette refusant, comme
 * `FedaPay.creerPaiement` : aucun appel réseau n'est écrit avant les accès
 * réels de la DGI. Le jour où ils arriveront, seule cette fonction change
 * (et APPELS_DGI avec) — la caisse, le verrou et les routes sont posés.
 */
export function emettreFacture(facture: FactureAEmettre): Promise<never> {
  // Squelette : la donnée reçue n'est encore transmise à personne, et elle
  // ne le sera qu'après agrément (voir APPELS_DGI).
  void facture;
  return Promise.reject(
    new Error('e-MECeF : appels DGI non branchés — accès à écrire après agrément.'),
  );
}
