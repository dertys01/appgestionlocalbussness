import { describe, it, expect } from 'vitest';
import { construireSauvegarde } from '@/lib/utils/sauvegarde';

/**
 * Sauvegarde complète.
 *
 * Le point qui compte : la PAGINATION. PostgREST plafonne à 1 000 lignes par
 * requête ; sans pagination, un commerce actif exporterait 1 000 ventes sur
 * 12 000, en silence. Ce test l'exerce au-delà de la limite.
 */
function faux(pages: Record<string, unknown[][]>) {
  return {
    from(table: string) {
      let debut = 0;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.range = (a: number) => { debut = a; return q; };
      // Thenable : `await` déclenche la « requête », comme supabase-js.
      q.then = (ok: (v: unknown) => unknown) => {
        const tout = pages[table] ?? [];
        const lot = tout.slice(debut, debut + 1000);
        return Promise.resolve({ data: lot, error: null }).then(ok);
      };
      return q;
    },
  } as unknown as Parameters<typeof construireSauvegarde>[0];
}

describe('construireSauvegarde', () => {
  it('pagine au-delà de 1 000 lignes', async () => {
    const produits = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const s = await construireSauvegarde(faux({ products: produits }));
    const donnees = JSON.parse(s.contenu).donnees;
    expect(donnees.products).toHaveLength(1500);
  });

  it('contient les tables du commerce et un en-tête', async () => {
    const s = await construireSauvegarde(faux({ products: [{ id: 1 }] }));
    const objet = JSON.parse(s.contenu);
    expect(objet.version).toBe(1);
    expect(typeof objet.exporte_le).toBe('string');
    expect(Object.keys(objet.donnees)).toContain('sales');
    expect(Object.keys(objet.donnees)).toContain('customer_debts');
  });

  it('nomme le fichier avec la date du jour', async () => {
    const s = await construireSauvegarde(faux({}));
    expect(s.nom).toMatch(/^sauvegarde-gestionlocal-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
