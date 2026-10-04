import { describe, expect, it } from 'vitest';

import { platsServisAujourdhui } from '@/lib/utils/menu';

/**
 * La carte du jour.
 *
 * Un restaurant ne sert pas le poisson le mardi. Une carte qui propose un plat
 * non servi est pire qu'une carte courte : le client commande ce qu'il voit, et
 * la cuisine ne cuisine pas ce qui n'est pas au menu.
 *
 * Ces tests sont sur la fonction pure, pas sur le rendu : la règle est un jour
 * de la semaine, et un test qui dépend de la date du jour serait vert trois
 * jours sur sept. Le jour est donc passé en paramètre.
 */

// 5 = vendredi, 6 = samedi, 2 = mardi.
const FRIDAY = 5;
const TUESDAY = 2;

const catalogue = [
  { id: 'quotidien', name: 'Poulet braisé', menu_days: null },
  { id: 'poisson', name: 'Poisson braisé', menu_days: [FRIDAY, 6] },
  { id: 'weekend', name: 'Brochettes', menu_days: [5, 6] },
  { id: 'archive', name: 'Plat retiré', menu_days: null, is_active: false },
];

describe('la carte du jour', () => {
  it('propose un plat sans jours tous les jours', () => {
    const ids = platsServisAujourdhui(catalogue, true, TUESDAY).map((p) => p.id);
    expect(ids).toContain('quotidien');
  });

  it('cache un plat qui ne se sert pas aujourd\'hui', () => {
    const ids = platsServisAujourdhui(catalogue, true, TUESDAY).map((p) => p.id);
    expect(ids).not.toContain('poisson');
    expect(ids).not.toContain('weekend');
  });

  it('propose le plat du jour le jour où il se sert', () => {
    const ids = platsServisAujourdhui(catalogue, true, FRIDAY).map((p) => p.id);
    expect(ids).toContain('poisson');
    expect(ids).toContain('weekend');
  });

  it('ne propose jamais un plat archivé, même servi aujourd\'hui', () => {
    for (const jour of [0, 1, 2, 3, 4, 5, 6]) {
      expect(platsServisAujourdhui(catalogue, true, jour).map((p) => p.id))
        .not.toContain('archive');
    }
  });

  it('laisse tout passer quand la carte du jour est désactivée', () => {
    // Le client demande LE plat absent du menu : refuser la commande
    // empêcherait le serveur de répondre « on peut ».
    const ids = platsServisAujourdhui(catalogue, false, TUESDAY).map((p) => p.id);
    expect(ids).toContain('poisson');
    expect(ids).toContain('weekend');
    // Le plat archivé reste invisible : c'est une autre règle.
    expect(ids).not.toContain('archive');
  });
});