import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

const { rpc, from, logActivity, inserted } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  logActivity: vi.fn(),
  inserted: [] as unknown[],
}));

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: {
      rpc,
      from,
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.c' } } }) },
    },
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    plan: 'pro',
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity }));

import { ProductImportModal } from '@/components/inventory/ProductImportModal';
import type { Product } from '@/types';

const produit = (name: string): Product =>
  ({ id: name, name, sku: null, category: null, price_buy: 0, price_sell: 0, stock_qty: 0, min_stock_level: 0 }) as unknown as Product;

/**
 * Chaîne PostgREST chaînable. `insert` enregistre ce qu'on lui confie et
 * renvoie autant d'identifiants que de lignes reçues : c'est ce que le
 * composant additionne pour annoncer « N produits importés ».
 */
function query(data: unknown[] = [], error: unknown = null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) q[m] = () => q;
  q.insert = (charge: unknown) => {
    const lot = Array.isArray(charge) ? charge : [charge];
    inserted.push(...lot);
    return query(lot.map((_, i) => ({ id: `n${i}` })), null);
  };
  q.then = (ok: unknown, ko: unknown) => Promise.resolve({ data, error }).then(ok as never, ko as never);
  return q;
}

const ENTETE = '"Produit","SKU","Catégorie","Prix achat (F)","Prix vente (F)","Stock","Stock min"';
const fichier = (lignes: string[]) => [ENTETE, ...lignes].join('\r\n');

/** Simule le choix du fichier : le <input type=file> ne se remplit pas tout seul. */
function choisirTexte(contenu: string) {
  const input = document.getElementById('import-produits-fichier') as HTMLInputElement;
  const fichierFaux = new File([contenu], 'tarifs.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [fichierFaux] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  from.mockReturnValue(query([]));
});

describe('ProductImportModal — ce que l\'utilisateur voit avant de valider', () => {
  it('propose le modèle avant tout, sinon le format reste invisible', () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText('Télécharger le modèle')).toBeInTheDocument();
  });

  it('annonce le nombre de produits à importer', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(fichier(['Riz 25 kg,"","cereal","12000","15000","0","0"']));

    await waitFor(() => expect(screen.getByText(/1 produit à importer/)).toBeInTheDocument());
  });

  it('refuse un fichier dont les colonnes obligatoires manquent', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte('foo,bar\n1,2');

    await waitFor(() => expect(screen.getByText(/Colonnes obligatoires introuvables/)).toBeInTheDocument());
  });
});

describe('ProductImportModal — les produits déjà présents ne sont pas écrasés', () => {
  it('ignore un produit déjà en boutique et l\'annonce', async () => {
    render(<ProductImportModal products={[produit('RIZ')]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(fichier(['RIZ,"","cereal","1200","1500","0","0"']));

    await waitFor(() => expect(screen.getByText(/0 produit à importer/)).toBeInTheDocument());
    expect(screen.getByText('Déjà en boutique')).toBeInTheDocument();
  });
});

describe('ProductImportModal — refus explicite d\'un prix de vente sous le prix d\'achat', () => {
  it('liste la ligne refusée avec la raison', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(fichier(['Perte,"","x","5000","3000","0","0"']));

    await waitFor(() => expect(screen.getByText(/1 refusé/)).toBeInTheDocument());
    expect(screen.getByText(/inférieur au prix/)).toBeInTheDocument();
  });
});

describe('ProductImportModal — l\'écriture en base', () => {
  it('n\'écrit rien tant que l\'utilisateur n\'a pas validé', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(fichier(['Riz,"","cereal","12000","15000","0","0"']));

    await waitFor(() => expect(screen.getByText(/1 produit à importer/)).toBeInTheDocument());
    expect(from).not.toHaveBeenCalled();
  });

  it('n\'importe que les lignes acceptées, jamais les refusées', async () => {
    const onDone = vi.fn();
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={onDone} />);
    choisirTexte(
      fichier([
        'Riz,"","cereal","12000","15000","0","0"',
        'Perte,"","x","5000","3000","0","0"',
      ])
    );

    await waitFor(() => expect(screen.getByText(/1 produit à importer/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Importer/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const noms = inserted.map((p) => (p as { name: string }).name);
    expect(noms).toEqual(['Riz']);
  });

  it('rattache les produits importés à la bonne boutique', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(fichier(['Riz,"","cereal","12000","15000","0","0"']));

    await waitFor(() => expect(screen.getByText(/1 produit à importer/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Importer/ }));

    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]).toMatchObject({
      user_id: 'org-1',
      name: 'Riz',
      price_buy: 12000,
      price_sell: 15000,
    });
  });

  it('annonce le nombre réellement importé', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(
      fichier([
        'Riz,"","cereal","12000","15000","0","0"',
        'Huile,"","cereal","3000","4000","0","0"',
      ])
    );

    await waitFor(() => expect(screen.getByText(/2 produits à importer/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Importer/ }));

    await waitFor(() => expect(screen.getByText('2 produits importés.')).toBeInTheDocument());
  });

  it('journalise l\'import, comme toute écriture de catalogue', async () => {
    render(<ProductImportModal products={[]} onClose={vi.fn()} onDone={vi.fn()} />);
    choisirTexte(fichier(['Riz,"","cereal","12000","15000","0","0"']));

    await waitFor(() => expect(screen.getByText(/1 produit à importer/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Importer/ }));

    await waitFor(() => expect(logActivity).toHaveBeenCalled());
    expect(JSON.stringify(logActivity.mock.calls[0])).toContain('product_import');
  });
});
