import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: { rpc, from },
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'user-1' },
    plan: 'pro',
  }),
}));

// Le journal d'activité importe le client Supabase, qui exige les variables
// d'environnement : hors test, rien à vérifier là-dessus.
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { ExpensesModule } from '@/components/reports/ExpensesModule';
import { formatCFA } from '@/lib/utils/currency';

/**
 * Testing Library normalise le texte du DOM (`/\s+/g` → espace) mais compare
 * la requête **brute**. formatCFA écrit les milliers avec une espace fine
 * insécable (U+202F) : demander `formatCFA(207444)` tel quel ne trouverait
 * jamais l'élément, puisque le DOM est réduit à un espace simple.
 * On applique donc au requête la même normalisation qu'au DOM.
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

/**
 * Relevé réel de la production, sur 30 jours — chiffres relevés en base.
 *
 * L'écran affichait « CA − charges » : 1 161 200 F, soit 86,1 % de marge
 * nette. Le coût des marchandises vendues (953 756 F) n'était déduit nulle
 * part et le commerçant paraissait 5,6 fois plus riche qu'il n'était.
 * Le vrai résultat est 207 444 F, soit 15,4 % — une marge de commerce de
 * détail, pas le 86 % que rien ne justifie dans la réalité.
 */
const RELEVE = [
  {
    day: '2026-09-15',
    revenue: 1_349_400,
    cogs: 953_756,
    expenses: 188_200,
    net: 207_444,
    transactions: 21,
  },
];

const AFFICHE = 1_161_200; // ce que l'écran montrait avant la correction

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'get_cash_flow' ? { data: RELEVE, error: null } : { data: null, error: null }
    )
  );
  from.mockImplementation((table: string) =>
    table === 'expense_categories'
      ? query([{ id: 'c1', name: 'Loyer', sort_order: 1 }])
      : query([])
  );
});

describe('ExpensesModule — le résultat net déduit le coût des marchandises', () => {
  it('affiche le vrai résultat, et pas celui qui oublie le coût d’achat', async () => {
    render(<ExpensesModule />);

    // 1 349 400 − 953 756 − 188 200
    expect(await screen.findByText(affiche(207_444))).toBeInTheDocument();
    // Le bénéfice fictif ne doit réapparaître sous aucune forme.
    expect(screen.queryByText(affiche(AFFICHE))).toBeNull();
  });

  it('montre le coût des marchandises : sans lui, la chute était inexplicable', async () => {
    render(<ExpensesModule />);

    expect(await screen.findByText('Marchandises')).toBeInTheDocument();
    // Le « − » vit hors de formatCFA : deux nœuds de texte dans le même div.
    expect(screen.getByText(`−${affiche(953_756)}`)).toBeInTheDocument();
    expect(screen.getByText('ce que vous avez payé')).toBeInTheDocument();
  });

  it('ramène la marge nette à un chiffre de commerce de détail (15,4 %, pas 86,1 %)', async () => {
    render(<ExpensesModule />);

    expect(await screen.findByText('15.4 %')).toBeInTheDocument();
    expect(screen.queryByText('86.1 %')).toBeNull();
    expect(screen.getByText('Marge nette')).toBeInTheDocument();
  });

  it('nomme les quatre termes de la chaîne comptable', async () => {
    render(<ExpensesModule />);

    expect(await screen.findByText('Résultat net')).toBeInTheDocument();
    expect(screen.getByText("Chiffre d'affaires")).toBeInTheDocument();
    expect(screen.getByText('Charges')).toBeInTheDocument();
    expect(screen.getByText('Marge nette')).toBeInTheDocument();
  });
});
