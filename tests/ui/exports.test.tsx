import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * Exports du Sprint 21 : Excel (CSV au séparateur français) et PDF (rapport
 * imprimable). Ce que ces tests verrouillent :
 *   - Excel s'ouvre en colonnes (« ; »), et une formule ne s'exécute pas ;
 *   - le PDF échappe les noms saisis (la page hérite de l'origine de l'app) ;
 *   - le carnet de dettes exporte la liste entière, et seulement avec le plan.
 */

const etat = vi.hoisted(() => ({ plan: 'starter', telecharge: [] as { csv: string; nom: string }[] }));

vi.mock('@/lib/utils/export', async (orig) => {
  const vrai = await orig<typeof import('@/lib/utils/export')>();
  return { ...vrai, downloadCSV: (csv: string, nom: string) => etat.telecharge.push({ csv, nom }) };
});

const dettes = Array.from({ length: 25 }, (_, i) => ({
  debt_id: `d${i}`,
  phone: i === 0 ? '2290197000001' : `22997000${String(i).padStart(3, '0')}`,
  name: i === 0 ? '=HYPERLINK("x")' : `Client ${i}`,
  total_due: 1000,
  total_paid: 500,
  last_sale_at: '2026-10-01T10:00:00Z',
  sales_count: 1,
  oldest_sale_at: '2026-10-01T10:00:00Z',
  payments_count: 1,
  last_payment_at: '2026-10-02',
}));

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: { rpc: async () => ({ data: dettes, error: null }) },
    canManageProducts: true,
    get plan() { return etat.plan; },
    org: { name: 'Boutique Test' },
  }),
}));

import { toCSV } from '@/lib/utils/export';
import { imprimerRapport } from '@/lib/utils/rapport';
import { DebtsModule } from '@/components/debts/DebtsModule';

describe('Excel (CSV)', () => {
  it('sépare par « ; » quand on le demande, et neutralise une formule', () => {
    const csv = toCSV([{ a: '=SOMME(A1)', b: 12 }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], ';');
    expect(csv.split('\n')[0]).toBe('"A";"B"');
    expect(csv.split('\n')[1]).toBe('"\'=SOMME(A1)";"12"');
  });

  it('garde la virgule par défaut (gabarit d\'import)', () => {
    expect(toCSV([{ a: 1 }, { a: 2 }], [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }])).toContain('"A","B"');
  });
});

describe('PDF (rapport imprimable)', () => {
  let page = '';
  beforeEach(() => {
    page = '';
    URL.createObjectURL = vi.fn((b: Blob) => { void b.text().then((t) => { page = t; }); return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('échappe les noms saisis et porte le total', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ addEventListener: vi.fn() } as unknown as Window);
    const ok = imprimerRapport({
      titre: 'Dettes clients', boutique: 'Chez <b>Koffi</b>', periode: 'au 7 octobre',
      colonnes: [{ label: 'Client' }, { label: 'Reste dû', droite: true }],
      lignes: [['<script>alert(1)</script>', '1 000 F']],
      total: ['1 client', '1 000 F'],
    });
    expect(ok).toBe(true);
    await vi.waitFor(() => expect(page).not.toBe(''));
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
    expect(page).toContain('Chez &lt;b&gt;Koffi&lt;/b&gt;');
    expect(page).toContain('<tfoot>');
    expect(page).toContain('@page{size:A4');
  });

  it('signale une fenêtre bloquée au lieu d\'échouer en silence', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(imprimerRapport({ titre: 't', boutique: 'b', periode: 'p', colonnes: [], lignes: [] })).toBe(false);
  });
});

describe('Carnet de dettes — exports', () => {
  beforeEach(() => { etat.telecharge = []; etat.plan = 'starter'; });

  it('exporte en Excel la liste ENTIÈRE, pas la page affichée', async () => {
    render(<DebtsModule />);
    fireEvent.click(await screen.findByRole('button', { name: /Excel/ }));
    const { csv, nom } = etat.telecharge[0];
    expect(nom).toMatch(/^dettes-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.split('\n')).toHaveLength(26); // en-tête + 25 dettes (la page en montre 20)
    expect(csv).toContain('"01 97 00 00 01"');
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
  });

  it('en plan gratuit : pas de bouton, une phrase calme', async () => {
    etat.plan = 'free';
    render(<DebtsModule />);
    expect(await screen.findByText(/export Excel et PDF est inclus à partir du plan Starter/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Excel/ })).toBeNull();
  });

  it('le bouton de relance ouvre WhatsApp avec l\'indicatif d\'un numéro à 10 chiffres', async () => {
    const ouvrir = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<DebtsModule />);
    const boutons = await screen.findAllByRole('button', { name: /Relancer/ });
    fireEvent.click(boutons[0]);
    expect(ouvrir).toHaveBeenCalled();
    expect(ouvrir.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/2290197000001\?text=/);
    ouvrir.mockRestore();
  });
});
