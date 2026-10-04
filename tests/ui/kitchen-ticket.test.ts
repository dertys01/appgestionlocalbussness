import { describe, expect, it, vi } from 'vitest';

import { printKitchenTicket, type KitchenTicket } from '@/lib/utils/kitchen';

/**
 * Le ticket de cuisine.
 *
 * Deux propriétés tiennent à cœur : il ne montre JAMAIS de prix — un
 * cuisinier qui connaît les tarifs discute avec le client, et un ticket laissé
 * sur la table devient une facture — et il échappe tout ce que le patron a
 * tapé. Un nom de plat contenant du HTML s'exécuterait dans une fenêtre
 * `blob:text/html`, qui hérite de l'origine de l'app et donc de la session
 * Supabase du restaurant.
 */

function capturer() {
  const blobs: string[] = [];
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const print = vi.fn();
  const close = vi.fn();
  const focus = vi.fn();
  const addEventListener = vi.fn();

  URL.createObjectURL = ((blob: Blob) => {
    blobs.push('__blob__');
    // Le contenu HTML est sur le Blob ; on lit via son texte asynchrone.
    void blob.text().then((t) => blobs.push(t));
    return 'blob:test';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

  vi.stubGlobal('open', vi.fn(() => ({
    print, close, focus, addEventListener,
  })));

  return {
    blobs,
    print,
    close,
    revokes: URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>,
    restore() {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    },
  };
}

const ticket: KitchenTicket = {
  orderId: 'cmd-1',
  tableName: 'Table 3',
  zone: 'Terrasse',
  openedAt: '2026-10-04T12:30:00Z',
  items: [
    { product_name: 'Poulet braisé', quantity: 2, note: null, modifier: 'Bien cuit', status: 'new' },
    { product_name: 'Riz parfumé', quantity: 1, note: 'sans oignons', modifier: null, status: 'new' },
  ],
  org: {
    id: 'o1', name: 'Maquis Chez Akim', slug: 'maquis', logo_url: null, plan: 'free',
    timezone: 'Africa/Porto-Novo', currency: 'XOF', onboarding_done: true, ifu: null,
    address: null, invoice_counter: 0, domain: 'restaurant', created_at: '', updated_at: '',
  },
};

async function htmlImprime(): Promise<string> {
  const c = capturer();
  const ok = printKitchenTicket(ticket);
  expect(ok).toBe(true);
  // Le contenu du Blob est résolu par `blob.text()`, une microtâche.
  await new Promise((r) => setTimeout(r, 0));
  c.restore();
  return c.blobs.filter((b) => b !== '__blob__').join('');
}

describe('printKitchenTicket', () => {
  it('affiche le plat, la quantité, la cuisson et la note', async () => {
    const html = await htmlImprime();
    expect(html).toContain('Poulet braisé');
    expect(html).toContain('Bien cuit');
    expect(html).toContain('sans oignons');
    expect(html).toContain('Table 3');
    expect(html).toContain('Terrasse');
  });

  it('ne contient AUCUN prix', async () => {
    const html = await htmlImprime();
    // Pas de « FCFA », pas de montant. La vue SQL restaurant_kitchen_ticket
    // ne contient aucune colonne de prix ; ce test vérifie que le rendu ne les
    // réintroduit pas. On ne cherche pas un nombre isolé : une quantité peut
    // légitimement valoir 12, et le CSS contient des pixels.
    expect(html).not.toMatch(/FCFA/);
    expect(html).not.toMatch(/\d[\d\s  ]*\s?F\b/);
  });

  it('échappe le HTML saisi par le patron', async () => {
    const c = capturer();
    printKitchenTicket({
      ...ticket,
      items: [{
        product_name: '<img src=x onerror=alert(1)>',
        quantity: 1,
        note: '<script>alert(2)</script>',
        modifier: null,
        status: 'new',
      }],
    });
    await new Promise((r) => setTimeout(r, 0));
    c.restore();

    const html = c.blobs.filter((b) => b !== '__blob__').join('');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
  });

  it('signale une fenêtre bloquée au lieu de marquer la commande partie', () => {
    // Le cas réel : un téléphone où l'utilisateur a bloqué les fenêtres. La
    // fonction doit RENDRE FALSE — l'appelant garde alors la commande « à
    // envoyer » au lieu de la marquer partie sans papier.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const revokes: unknown[] = [];
    URL.createObjectURL = vi.fn(() => 'blob:test') as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => { revokes.push(u); }) as typeof URL.revokeObjectURL;
    vi.stubGlobal('open', vi.fn(() => null));

    const ok = printKitchenTicket(ticket);

    expect(ok).toBe(false);
    // L'URL est libérée plutôt que laissée fuiter.
    expect(revokes).toHaveLength(1);

    vi.unstubAllGlobals();
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
});