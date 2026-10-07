import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { rpc, from, supabase } = vi.hoisted(() => {
  // L'objet doit être STABLE dans le temps : DailyJournal déclenche son
  // chargement dans un useEffect qui dépend du client. Un `{ rpc, from }`
  // recréé à chaque render de useSupabase() changerait cette référence à
  // chaque render → effet relancé → render → … boucle jusqu'au OOM.
  const rpc = vi.fn();
  const from = vi.fn();
  return { rpc, from, supabase: { rpc, from } };
});

const acces = vi.hoisted(() => ({ plan: 'pro' }));

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'user-1' },
    get plan() { return acces.plan; },
  }),
}));

import { DailyJournal } from '@/components/sales/DailyJournal';
import { formatCFA } from '@/lib/utils/currency';
import { addDays, todayISO } from '@/lib/utils/period';

/**
 * Testing Library normalise les espaces du DOM ; formatCFA écrit une espace
 * fine insécable (U+202F) pour les milliers. Même normalisation des deux côtés.
 */
const affiche = (n: number) => formatCFA(n).replace(/\s+/g, ' ');

/** Chaîne PostgREST : chaque appel renvoie le même objet, thenable à la fin. */
function query(data: unknown[], error: unknown = null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) q[m] = () => q;
  q.then = (ok: unknown, ko: unknown) =>
    Promise.resolve({ data, error }).then(ok as never, ko as never);
  return q;
}

const JOUR = todayISO();

const VENTE = {
  id: 's1',
  user_id: 'u1',
  total_amount: 25000,
  payment_method: 'momo',
  settled: true,
  amount_received: 25000,
  client_name: 'Koffi',
  client_phone: null,
  note: null,
  created_at: `${JOUR}T10:30:00`,
  sale_items: [
    {
      id: 'i1',
      sale_id: 's1',
      product_id: 'p1',
      product_name: 'Riz local',
      quantity: 2,
      unit_price: 12500,
      subtotal: 25000,
    },
  ],
};

const FLOW = [{ day: JOUR, revenue: 45000, cogs: 30000, expenses: 5000, net: 10000, transactions: 3 }];
const SUMMARY = [{ day: JOUR, revenue: 45000, cash: 30000, momo: 15000, tx: 3 }];
const CHARGE = {
  id: 'e1',
  category: 'Loyer',
  label: 'Loyer boutique',
  amount: 5000,
  day: JOUR,
  note: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(fn === 'get_cash_flow' ? { data: FLOW, error: null } : { data: SUMMARY, error: null })
  );
  from.mockImplementation((table: string) => (table === 'sales' ? query([VENTE]) : query([CHARGE])));
});

describe('Journal du jour', () => {
  it('affiche les quatre chiffres du jour : CA, marge, charges, net', async () => {
    render(<DailyJournal />);

    expect(await screen.findByText(affiche(45000))).toBeInTheDocument(); // CA encaissé
    expect(screen.getByText('Marge brute')).toBeInTheDocument();
    expect(screen.getByText(affiche(15000))).toBeInTheDocument(); // 45 000 − 30 000
    // « 5 000 F » est affiché deux fois, à juste titre : la carte Charges et
    // le total de la section Charges du jour. Les deux doivent le porter.
    expect(screen.getAllByText(affiche(5000)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Résultat net')).toBeInTheDocument();
    expect(screen.getByText(affiche(10000))).toBeInTheDocument(); // après CMV et charges
    // La ventilation espèces/MoMo est sous le CA : un jour sans MoMo ne
    // doit pas se deviner en additionnant la liste.
    expect(screen.getByText(/Espèces 30[\s\u202f]000 F · MoMo 15[\s\u202f]000 F/)).toBeInTheDocument();
  });

  it('détaille les ventes du jour, dépliables article par article', async () => {
    render(<DailyJournal />);

    expect(await screen.findByText('Koffi')).toBeInTheDocument();
    expect(screen.getByText('MoMo')).toBeInTheDocument();
    expect(screen.getByText(/1 vente ·/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Koffi'));
    expect(await screen.findByText(/Riz local/)).toBeInTheDocument();
    expect(screen.getByText(/2 ×/)).toBeInTheDocument();
  });

  it('détaille les charges du jour et leur total', async () => {
    render(<DailyJournal />);

    expect(await screen.findByText('Loyer boutique')).toBeInTheDocument();
    expect(screen.getByText('Loyer')).toBeInTheDocument(); // catégorie
    expect(screen.getByText(`−${affiche(5000)}`)).toBeInTheDocument();
  });

  it('navigue d’un jour à l’autre, puis revient à aujourd’hui', async () => {
    render(<DailyJournal />);
    await screen.findByText(/Aujourd’hui/);

    fireEvent.click(screen.getByRole('button', { name: 'Jour précédent' }));
    await waitFor(() => {
      expect(rpc).toHaveBeenLastCalledWith(
        'get_sales_summary',
        expect.objectContaining({ p_from: addDays(JOUR, -1), p_to: addDays(JOUR, -1) })
      );
    });

    // Le bouton « Aujourd’hui » n’existe que quand on a quitté le jour courant.
    fireEvent.click(await screen.findByRole('button', { name: 'Aujourd’hui' }));
    await waitFor(() => {
      // get_sales_summary est le dernier des appels parallèles : si c'est lui
      // qui porte JOUR (après un aller-retour par JOUR-1), c'est bien le
      // rechargement du jour courant qui vient d'avoir lieu.
      expect(rpc).toHaveBeenLastCalledWith(
        'get_sales_summary',
        expect.objectContaining({ p_from: JOUR, p_to: JOUR })
      );
    });
  });

  it('refus de plan sur get_cash_flow : le journal reste utilisable', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'get_cash_flow'
          ? {
              data: null,
              error: {
                message:
                  'La fonctionnalité « cashflow » nécessite le plan starter (plan actuel : free).',
              },
            }
          : { data: SUMMARY, error: null }
      )
    );

    render(<DailyJournal />);

    // La raison s’affiche…
    expect(await screen.findByText(/nécessite le plan Starter/)).toBeInTheDocument();
    // …la marge et le net tombent en « — » (données indisponibles, pas zéro)…
    expect(screen.getAllByText('—')).toHaveLength(2);
    // …mais CA, ventes et charges saisies restent là : charges vient de la
    // liste, pas de get_cash_flow.
    expect(await screen.findByText('Koffi')).toBeInTheDocument();
    expect(await screen.findByText('Loyer boutique')).toBeInTheDocument();
    expect(await screen.findByText(affiche(45000))).toBeInTheDocument();
    // KPI Charges + total de section : les deux affichent la somme des
    // charges saisies, puisque get_cash_flow est refusée.
    expect((await screen.findAllByText(affiche(5000))).length).toBeGreaterThanOrEqual(2);
  });

  it('plan gratuit : encaissé et nombre de ventes, sans appel refusé ni bandeau', async () => {
    acces.plan = 'free';
    try {
      rpc.mockImplementation(() => Promise.resolve({ data: SUMMARY, error: null }));
      render(<DailyJournal />);

      expect(await screen.findByText(affiche(45000))).toBeInTheDocument();
      expect(screen.getByText('enregistrées ce jour')).toBeInTheDocument();
      // La base n'est même pas sollicitée : elle répondrait 403.
      expect(rpc.mock.calls.map((c) => c[0])).not.toContain('get_cash_flow');
      expect(screen.queryByText(/nécessite le plan/)).toBeNull();
      expect(screen.queryByText('Marge brute')).toBeNull();
      // Les charges se saisissent dans Rapports, payant et masqué en mode simple.
      expect(screen.queryByText('Charges du jour')).toBeNull();
      expect(screen.getByText(/inclus à partir du plan Starter/)).toBeInTheDocument();
    } finally {
      acces.plan = 'pro';
    }
  });

  it('jour sans activité : états vides explicites, pas un écran blanc', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'get_cash_flow' ? { data: [], error: null } : { data: [], error: null })
    );
    from.mockImplementation(() => query([]));

    render(<DailyJournal />);

    expect(await screen.findByText('Aucune vente ce jour-là')).toBeInTheDocument();
    expect(screen.getByText('Aucune charge ce jour-là')).toBeInTheDocument();
  });
});
