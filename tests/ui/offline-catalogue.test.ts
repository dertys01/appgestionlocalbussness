import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { ecrireCatalogue, lireCatalogue } from '@/lib/offline/catalogue';

/**
 * Cache local du catalogue (P7).
 *
 * Ce qui compte : le repli doit être PAR BOUTIQUE — deux commerces sur le même
 * appareil ne doivent jamais se voir. Et une boutique jamais chargée doit
 * renvoyer `null`, pas une liste vide (qui se lirait « catalogue vide » au
 * lieu de « on ne sait pas »).
 */
describe('cache catalogue hors-ligne', () => {
  it('écrit puis relit le catalogue d’une boutique', async () => {
    await ecrireCatalogue('org-1', [{ id: 'p1', name: 'Riz' }]);
    expect(await lireCatalogue('org-1')).toEqual([{ id: 'p1', name: 'Riz' }]);
  });

  it('ne mélange pas deux boutiques', async () => {
    await ecrireCatalogue('org-2', [{ id: 'x', name: 'Autre' }]);
    expect(await lireCatalogue('org-1')).toEqual([{ id: 'p1', name: 'Riz' }]);
    expect(await lireCatalogue('org-2')).toEqual([{ id: 'x', name: 'Autre' }]);
  });

  it('renvoie null pour une boutique jamais chargée', async () => {
    expect(await lireCatalogue('org-inconnue')).toBeNull();
  });
});
