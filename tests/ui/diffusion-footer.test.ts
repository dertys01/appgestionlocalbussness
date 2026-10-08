import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, Plan } from '@/types';
import { generateWhatsAppReceiptLink, piedDiffusion } from '@/lib/utils/whatsapp';
import { reminderLink } from '@/components/debts/DebtsModule';
import { printReceipt } from '@/lib/utils/print';

// DebtsModule importe la chaîne SupabaseProvider → client, qui exige les
// clés publiques au chargement. Ce test n'appelle qu'une fonction pure du
// module : le provider est remplacé, comme dans les tests POS.
vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({}),
}));

/**
 * P4 — pied de page « Envoyé avec GestionLocal » (évaluation §6).
 *
 * La mention est une boucle de diffusion naturelle : elle existe sur les
 * reçus et relances du plan gratuit, et **uniquement** là — retirée dès le
 * Starter, y compris pendant l'essai (l'essai est un Starter) et y compris
 * quand une période prépayée éteinte ramène l'org au gratuit (la mention
 * revient alors, puisque le plan est devenu free).
 *
 * Les trois surfaces sont vérifiées avec la même règle, parce qu'elles
 * partagent la même fonction `piedDiffusion()` — mais un oubli de branchement
 * sur l'une d'elles ne se verrait pas ailleurs.
 */

const MENTION = 'Envoyé avec GestionLocal';

const texte = (url: string) => decodeURIComponent(url.split('?text=')[1] ?? '');

const vente = {
  items: [{ product_name: 'Riz', quantity: 2, unit_price: 1000, subtotal: 2000 }],
  total: 2000,
  date: new Date('2026-06-15T10:00:00Z'),
  businessName: 'Chez Koffi',
  paymentMethod: 'cash' as const,
};

const dette = {
  debt_id: 'd1',
  phone: '22997000001',
  name: 'Awa',
  total_paid: 0,
  total_due: 5000,
  last_sale_at: '2026-06-01T00:00:00Z',
  sales_count: 2,
  oldest_sale_at: '2026-06-01T00:00:00Z',
  payments_count: 0,
  last_payment_at: null,
};

const DEMAIN = new Date(Date.now() + 86_400_000).toISOString();
const HIER = new Date(Date.now() - 86_400_000).toISOString();

function org(plan: Plan, extra: Partial<Organization> = {}): Organization {
  return {
    id: 'o1',
    name: 'Chez Koffi',
    slug: 'chez-koffi',
    logo_url: null,
    plan,
    timezone: 'Africa/Porto-Novo',
    currency: 'XOF',
    onboarding_done: true,
    ifu: null,
    address: null,
    invoice_counter: 0,
    domain: 'retail',
    ...extra,
  } as Organization;
}

describe('piedDiffusion — la règle unique', () => {
  it('free → séparateur + mention', () => {
    expect(piedDiffusion('free')).toEqual(['', MENTION]);
  });

  it('starter, pro, plan absent ou null → rien', () => {
    expect(piedDiffusion('starter')).toEqual([]);
    expect(piedDiffusion('pro')).toEqual([]);
    expect(piedDiffusion(undefined)).toEqual([]);
    expect(piedDiffusion(null)).toEqual([]);
  });
});

describe('Reçu WhatsApp — pied de page', () => {
  it('plan gratuit : la mention ferme le message', () => {
    const m = texte(generateWhatsAppReceiptLink({ ...vente, plan: 'free' }, '22997000001'));
    expect(m).toContain(MENTION);
    expect(m.trimEnd().endsWith(MENTION)).toBe(true);
  });

  it.each(['starter', 'pro'] as const)(
    'plan %s : aucune mention',
    (plan) => {
      const m = texte(generateWhatsAppReceiptLink({ ...vente, plan }, '22997000001'));
      expect(m).not.toContain(MENTION);
    },
  );

  it('plan non transmis (ancien appelant) : aucune mention', () => {
    const m = texte(generateWhatsAppReceiptLink(vente, '22997000001'));
    expect(m).not.toContain(MENTION);
  });

  it('branche crédit : la mention n’altère pas le rappel de dette', () => {
    const m = texte(generateWhatsAppReceiptLink(
      { ...vente, paymentMethod: 'credit', due: 2000, plan: 'free' },
      '22997000001',
    ));
    expect(m).toContain(MENTION);
    expect(m).toMatch(/régler quand vous pouvez/);
    expect(m).not.toMatch(/Merci pour votre achat/);
  });
});

describe('Relance de dette — pied de page', () => {
  it('plan gratuit : la mention ferme la relance', () => {
    const m = texte(reminderLink(dette, 'free'));
    expect(m).toContain(MENTION);
    expect(m).toMatch(/Passez me payer quand vous pouvez/);
  });

  it.each(['starter', 'pro'] as const)('plan %s : aucune mention', (plan) => {
    const m = texte(reminderLink(dette, plan));
    expect(m).not.toContain(MENTION);
  });
});

describe('Reçu imprimé — pied de page', () => {
  let blobs: Blob[] = [];
  const fauxWin = {
    print: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    addEventListener: vi.fn(),
  };
  const urlOriginaux: Partial<Record<'createObjectURL' | 'revokeURL', unknown>> = {};

  beforeEach(() => {
    blobs = [];
    urlOriginaux.createObjectURL ??= URL.createObjectURL;
    (URL as { createObjectURL?: unknown }).createObjectURL = (b: Blob) => {
      blobs.push(b);
      return 'blob:test';
    };
    vi.spyOn(window, 'open').mockReturnValue(fauxWin as unknown as Window);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (URL as { createObjectURL?: unknown }).createObjectURL = urlOriginaux.createObjectURL;
  });

  async function htmlRecu(o: Organization): Promise<string> {
    const avant = blobs.length;
    printReceipt({
      items: [],
      total: 2000,
      paymentMethod: 'cash',
      clientName: '',
      amountGiven: 0,
      change: 0,
      date: new Date('2026-06-15T10:00:00Z'),
      invoiceNumber: null,
      org: o,
    });
    expect(blobs.length).toBe(avant + 1);
    return await blobs[blobs.length - 1].text();
  }

  it('plan gratuit : la mention figure sur le papier', async () => {
    expect(await htmlRecu(org('free'))).toContain(MENTION);
  });

  it('essai actif (free + échéance future) : aucune mention', async () => {
    expect(await htmlRecu(org('free', { trial_ends_at: DEMAIN }))).not.toContain(MENTION);
  });

  it('essai écoulé : le plan redevient free, la mention revient', async () => {
    expect(await htmlRecu(org('free', { trial_ends_at: HIER }))).toContain(MENTION);
  });

  it('période prépayée éteinte : le plan retombe sur free, mention incluse', async () => {
    const o = org('starter', { plan_valid_until: HIER });
    expect(await htmlRecu(o)).toContain(MENTION);
  });

  it.each(['starter', 'pro'] as const)(
    'plan %s : aucune mention',
    async (plan) => {
      expect(await htmlRecu(org(plan))).not.toContain(MENTION);
    },
  );
});
