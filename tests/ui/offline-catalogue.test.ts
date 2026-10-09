import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  ecrireCatalogue,
  lireCatalogue,
  ecrireBoutique,
  lireBoutique,
  ecrireMembre,
  lireMembre,
} from '@/lib/offline/catalogue';

/**
 * Cache local (P7).
 *
 * Ce qui compte : le repli doit être PAR identifiant — deux commerces sur le
 * même appareil ne doivent jamais se voir. Et une clé jamais écrite doit
 * renvoyer `null`, pas une valeur vide (qui se lirait « catalogue vide » au
 * lieu de « on ne sait pas »).
 */
describe('cache local hors-ligne', () => {
  it('écrit puis relit le catalogue d’une boutique', async () => {
    await ecrireCatalogue('org-1', [{ id: 'p1', name: 'Riz' }]);
    expect(await lireCatalogue('org-1')).toEqual([{ id: 'p1', name: 'Riz' }]);
  });

  it('ne mélange pas deux boutiques', async () => {
    await ecrireCatalogue('org-2', [{ id: 'x', name: 'Autre' }]);
    expect(await lireCatalogue('org-1')).toEqual([{ id: 'p1', name: 'Riz' }]);
    expect(await lireCatalogue('org-2')).toEqual([{ id: 'x', name: 'Autre' }]);
  });

  it('renvoie null pour une clé jamais écrite', async () => {
    expect(await lireCatalogue('org-inconnue')).toBeNull();
    expect(await lireBoutique('org-inconnue')).toBeNull();
    expect(await lireMembre('user-inconnu')).toBeNull();
  });

  it('conserve la boutique et le rattachement (clés distinctes)', async () => {
    await ecrireBoutique('org-1', { id: 'org-1', name: 'Boutique Test' });
    await ecrireMembre('user-1', { ownerId: 'org-1', isEmployee: false, actorName: 'Patron', canManageProducts: true });

    expect(await lireBoutique<{ name: string }>('org-1')).toEqual({ id: 'org-1', name: 'Boutique Test' });
    expect(await lireMembre<{ ownerId: string }>('user-1')).toEqual({
      ownerId: 'org-1', isEmployee: false, actorName: 'Patron', canManageProducts: true,
    });
    // Le catalogue d'org-1 reste distinct de sa boutique : mêmes identifiants,
    // clés différentes.
    expect(await lireCatalogue('org-1')).toEqual([{ id: 'p1', name: 'Riz' }]);
  });
});

