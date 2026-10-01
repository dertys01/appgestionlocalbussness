// Le refus de plan remonte de PostgreSQL en français technique. Ce qu'un
// commerçant lit à l'écran ne doit pas être « La fonctionnalité « forecast »
// nécessite le plan pro (plan actuel : free). » — ni, à l'inverse, un message
// générique qui masquerait pourquoi l'écran est vide.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readablePlanError } from '../src/lib/utils/planErrors.ts';

const message = (req: string, actuel: string) =>
  `La fonctionnalité « ${req} » nécessite le plan ${req} (plan actuel : ${actuel}).`;

describe('readablePlanError', () => {
  it('demande le plan Pro pour les prévisions', () => {
    const out = readablePlanError(message('pro', 'free'));
    assert.match(out, /plan Pro/);
    // Le plan manquant doit être nommé, sinon le commerçant ne sait pas quoi
    // acheter.
    assert.match(out, /réapprovisionnement/i);
  });

  it('demande le plan Starter pour les rapports, en nommant le plan actuel', () => {
    const out = readablePlanError(message('starter', 'free'));
    assert.match(out, /Starter/);
    assert.match(out, /Gratuit/);
  });

  it('traduit un Starter qui tente d\'accéder aux prévisions', () => {
    const out = readablePlanError(message('pro', 'starter'));
    assert.match(out, /plan Pro/);
    assert.match(out, /Starter/);
  });

  it('traduit un Pro qui tente d\'accéder aux rapports', () => {
    const out = readablePlanError(message('starter', 'pro'));
    assert.match(out, /Starter/);
    assert.match(out, /Pro/);
  });

  it('ne masque pas un message qu\'elle ne reconnaît pas', () => {
    // Principe : si la reconnaissance échoue, on rend le message tel quel.
    // Réécrire en « une erreur est survenue » ferait perdre l'information au
    // moment où l'on en a le plus besoin.
    const brut = 'violation de clé étrangère sur sale_items_product_id_fkey';
    assert.equal(readablePlanError(brut), brut);
  });

  it('traduit une session expirée', () => {
    assert.match(readablePlanError('Non authentifié'), /reconnectez/i);
  });

  it('traduit une panne réseau sans masquer la cause', () => {
    assert.match(readablePlanError('TypeError: Failed to fetch'), /[Rr]éseau/);
  });

  it('remonte une fonctionnalité inconnue telle quelle', () => {
    const brut = 'Fonctionnalité inconnue : raepots';
    assert.equal(readablePlanError(brut), brut);
  });
});
