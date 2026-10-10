import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Impression d'un reçu.
 *
 * Deux règles d'argent sur le papier : le reçu montre le prix RÉELLEMENT
 * encaissé (pas le catalogue), et un reçu de crédit dit toujours ce qui a été
 * versé et ce qui reste dû — jamais « réglé » par omission.
 */
import { printReceipt } from '@/lib/utils/print';
import type { CartItem, Organization } from '@/types';

function item(nom: string, prix: number, qte: number, unitPrice: number | null = null): CartItem {
  return { product: { name: nom, price_sell: prix } as CartItem['product'], quantity: qte, unitPrice };
}

const ORG = { id: 'o1', name: 'Chez Koffi', slug: 'k', logo_url: null, plan: 'pro', timezone: 'Africa/Porto-Novo', currency: 'XOF', onboarding_done: true, ifu: null, address: null, invoice_counter: 0, domain: 'retail' } as Organization;

/** Capture le HTML écrit dans le Blob, et fournit une fenêtre factice. */
function capturer({ popupBloquee = false } = {}) {
  const htmls: string[] = [];
  const revoke = vi.fn();
  const fakeWin = { addEventListener: vi.fn(), focus: vi.fn(), close: vi.fn(), print: vi.fn() };

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => { void blob.text().then((t) => htmls.push(t)); return 'blob:recu'; },
    revokeObjectURL: revoke,
  });
  vi.spyOn(window, 'open').mockReturnValue(popupBloquee ? null : (fakeWin as unknown as Window));

  return { htmls, revoke, fakeWin };
}

const base = {
  items: [item('Riz', 500, 2)],
  total: 1000,
  paymentMethod: 'cash' as const,
  clientName: '',
  amountGiven: 1000,
  change: 0,
  date: new Date('2026-10-10T10:00:00Z'),
  org: ORG,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const lire = async (c: { htmls: string[] }) => {
  await new Promise((r) => setTimeout(r, 0));
  return c.htmls.join('');
};

describe('printReceipt', () => {
  it('montre le prix réellement encaissé et la remise consentie', async () => {
    const c = capturer();
    printReceipt({ ...base, items: [item('Riz', 500, 2, 400)] });
    const html = await lire(c);

    expect(html).toContain('remise');
    // 400 F encaissé, pas 500 F catalogue.
    expect(html).toContain('800');
  });

  it('espèces avec monnaie : reçu et monnaie rendue', async () => {
    const c = capturer();
    printReceipt({ ...base, amountGiven: 2000, change: 1000 });
    const html = await lire(c);

    expect(html).toContain('Espèces');
    expect(html).toContain('Reçu');
    expect(html).toContain('Monnaie');
  });

  it('crédit avec acompte : déjà versé et reste à régler', async () => {
    const c = capturer();
    printReceipt({ ...base, paymentMethod: 'credit', total: 130000, amountGiven: 0, change: 0, advance: 50000, due: 80000 });
    const html = await lire(c);

    expect(html).toContain('Crédit (à recouvrer)');
    expect(html).toContain('Déjà versé');
    expect(html).toContain('Reste à régler');
    expect(html).toContain('80');
  });

  it('crédit sans reste indiqué : le reste dû vaut le prix (jamais « réglé »)', async () => {
    const c = capturer();
    printReceipt({ ...base, paymentMethod: 'credit', total: 130000, amountGiven: 0, change: 0 });
    const html = await lire(c);

    expect(html).toContain('Reste à régler');
    expect(html).toContain('130');
  });

  it('Mobile Money', async () => {
    const c = capturer();
    printReceipt({ ...base, paymentMethod: 'momo' });
    expect(await lire(c)).toContain('Mobile Money');
  });

  it('popup bloquée : n’échoue pas et libère l’URL', async () => {
    const c = capturer({ popupBloquee: true });
    expect(() => printReceipt(base)).not.toThrow();
    expect(c.revoke).toHaveBeenCalledWith('blob:recu');
  });
});
