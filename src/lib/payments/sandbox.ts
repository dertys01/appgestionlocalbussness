/**
 * Bac à sable local : le parcours Mobile Money COMPLET, sans centime et sans
 * appel réseau.
 *
 * Rôle : permettre de tester — et de démontrer — la chaîne entière avant
 * même d'avoir des clés : commande → page de paiement → confirmation →
 * activation du plan → échéance. L'évaluation annonce justement un choix de
 * prestataire « à trancher par un essai en bac à sable » : ce module EST le
 * banc d'essai, prêt à être remplacé par le vrai.
 *
 * Sécurité : la confirmation d'un vrai webhook se vérifie par signature.
 * Ici il n'y en a pas — la page est ouverte par le·la patron·ne lui-même.
 * Deux verrous compensent, dans la route webhook :
 *   1. PAYMENTS_SANDBOX doit valoir « 1 » (jamais le cas en production) ;
 *   2. session authentifiée, et la commande doit appartenir à son·sa
 *      propriétaire — un jeton de commande volé ne servirait à rien.
 * Sans ces deux verrous, `verifierCallback` retourne null.
 */

import type { DemandePaiement, PaiementCree, Confirmation, Prestataire } from './types';

/** Référence de commande : 36 caractères hexadécimaux (randomBytes(18)). */
const REF_PATTERN = /^[a-f0-9]{36}$/;

export class Sandbox implements Prestataire {
  readonly id = 'sandbox' as const;

  async creerPaiement(demande: DemandePaiement): Promise<PaiementCree> {
    if (process.env.PAYMENTS_SANDBOX !== '1') {
      // Off par défaut : en production sans configuration, on refuse de
      // vendre plutôt que de proposer une page de confirmation morte.
      throw new Error('Bac à sable désactivé (PAYMENTS_SANDBOX).');
    }
    // Chemin RELATIF, volontairement : la redirection est faite par le
    // navigateur du·de la commerçant·e, qui est déjà sur le bon hôte. Un
    // hôte codé ici (NEXT_PUBLIC_APP_URL pointe sur la production) enverrait
    // les essais locaux sur le mauvais domaine.
    return {
      providerRef: `sbx_${demande.reference.slice(0, 16)}`,
      redirectUrl: `/paiement/sandbox/${demande.reference}`,
    };
  }

  verifierCallback(corps: string, enTetes: Headers): Confirmation | null {
    if (process.env.PAYMENTS_SANDBOX !== '1') return null;
    // La session (en-tête Authorization) est vérifiée par la route, pas ici :
    // cette couche ne contrôle que la forme du corps.
    void enTetes;
    try {
      const v = JSON.parse(corps) as { reference?: unknown };
      if (typeof v.reference !== 'string' || !REF_PATTERN.test(v.reference)) return null;
      return { reference: v.reference, ok: true };
    } catch {
      return null;
    }
  }
}
