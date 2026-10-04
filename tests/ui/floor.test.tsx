import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * La salle : le plan des tables et la commande ouverte.
 *
 * Ce que ces tests verrouillent : une table libre s'ouvre en UNE commande, et
 * la commande n'écrit RIEN sur le stock. Ce second point est le cœur du Sprint
 * 13 — une commande est une intention de service, pas une vente ; seul le
 * Sprint 14 écrira dans `sales`.
 */

const { salle, inserts, lignesCommande } = vi.hoisted(() => {
  const inserts: Array<Record<string, unknown>> = [];
  return { salle: [] as unknown[], inserts, lignesCommande: [] as unknown[] };
});

// Le plan de salle vient de la vue restaurant_floor, qui répond déjà au tri :
// chaque appel .from('restaurant_floor') rend une promesse résolue.
const chaine = (donnees: unknown) => {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = () => c;
  // Le module enchaîne deux .order() (zone puis nom) : la chaîne doit donc
  // rester elle-même jusqu'au dernier, et se résoudre à l'await. Une promesse
  // dès le premier .order() faisait échouer le deuxième.
  c.order = () => c;
  // thenable : la chaîne se comporte comme une promesse à l'await, mais reste
  // elle-même tant qu'on l'enchaîne.
  c.then = (ok: (v: unknown) => unknown) => ok({ data: donnees, error: null });
  c.insert = (payload: Record<string, unknown>) => {
    inserts.push(payload);
    return { select: () => ({ single: async () => ({ data: { id: 'cmd-1' }, error: null }) }) };
  };
  c.update = () => ({ eq: async () => ({ error: null }) });
  c.delete = () => ({ eq: async () => ({ error: null }) });
  return c;
};

const { rpcResultats } = vi.hoisted(() => ({ rpcResultats: [] as unknown[] }));

const supabase = {
  from: (table: string) =>
    table === 'restaurant_floor'
      ? chaine(salle)
      : table === 'restaurant_order_items'
        ? chaine(lignesCommande)
        : chaine({ id: 'x' }),
  rpc: vi.fn(async (fn: string) => {
    rpcResultats.push(fn);
    if (fn === 'close_table_order') {
      return {
        data: { total_amount: 9200, amount_paid: 9200, invoice_number: 'FAC-2026-00042', sale_id: 'v-1', per_share: 4600 },
        error: null,
      };
    }
    return { data: 1, error: null };
  }),
  auth: { getUser: vi.fn() },
};

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    canManageProducts: true,
    isEmployee: false,
    org: { domain: 'restaurant' },
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { FloorModule } from '@/components/restaurant/FloorModule';
import type { Product } from '@/types';

const produits = [
  { id: 'p1', name: 'Poulet braisé', sku: 'POU', price_buy: 2000, price_sell: 4500, stock_qty: 30, min_stock_level: 5, category: 'Plats', unit: 'pce' },
] as unknown as Product[];

const table = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Table 1',
  zone: 'Salle',
  seats: 4,
  is_active: true,
  order_id: null as string | null,
  status: null as 'open' | 'bill_requested' | null,
  customer_name: null as string | null,
  opened_at: null as string | null,
  amount_paid: 0,
  order_total: 0,
  ...over,
});

function definirSalle(...lignes: ReturnType<typeof table>[]) {
  salle.length = 0;
  salle.push(...lignes);
}

function definirCommande(...ls: unknown[]) {
  lignesCommande.length = 0;
  lignesCommande.push(...ls);
}

const plat = {
  id: 'l1',
  product_id: 'p1',
  quantity: 2,
  unit_price: 4500,
  note: null,
  status: 'new',
  product: { name: 'Poulet braisé' },
};

describe('FloorModule — la salle', () => {
  it('propose de créer une table quand la salle est vide', async () => {
    definirSalle();
    render(<FloorModule products={produits} />);

    await waitFor(() => {
      expect(screen.getByText(/Aucune table configurée/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Nom de la table/i)).toBeInTheDocument();
  });

  it('distingue table libre et table occupée', async () => {
    definirSalle(
      table({ id: 't1', name: 'Table 1' }),
      table({
        id: 't2', name: 'Table 2', order_id: 'cmd-9', status: 'open',
        customer_name: 'M. Kponou', opened_at: new Date().toISOString(), order_total: 9500,
      }),
    );
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 2')).toBeInTheDocument());
    expect(screen.getByText('Libre')).toBeInTheDocument();
    expect(screen.getByText('En service')).toBeInTheDocument();
    expect(screen.getByText('M. Kponou')).toBeInTheDocument();
  });

  it('affiche « addition demandée » distinctement de « en service »', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'bill_requested', opened_at: new Date().toISOString() }));
    render(<FloorModule products={produits} />);

    await waitFor(() => {
      expect(screen.getByText('Addition demandée')).toBeInTheDocument();
    });
    expect(screen.queryByText('En service')).not.toBeInTheDocument();
  });

  it('montre le temps de service écoulé', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open', opened_at: new Date(Date.now() - 42 * 60000).toISOString() }));
    render(<FloorModule products={produits} />);

    // Une table servie depuis 42 minutes doit le dire : c'est le signal qui
    // dit au patron qu'une table doit attendre ou être relancée.
    await waitFor(() => expect(screen.getByText(/42 min/)).toBeInTheDocument());
  });

  it('ouvre une commande unique en touchant une table libre', async () => {
    inserts.length = 0;
    definirSalle(table());
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    await waitFor(() => expect(inserts.length).toBe(1));
    expect(inserts[0].table_id).toBe('t1');
    expect(inserts[0].owner_id).toBe('org-1');
    // L'unicité vient de l'index partiel en base ; le client n'écrit qu'une fois.
    expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument();
  });

  it('partage l\'addition sans multiplier les ventes', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open', customer_name: 'M. Kponou' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());
    // La ligne doit être chargée : le partage n'apparaît qu'au-dessus d'une
    // commande non vide. Le plat apparaît aussi dans la grille de choix, d'où
    // getAllByText.
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));

    fireEvent.click(screen.getByText(/Partager l'addition/i));
    // 2 parts sur 9 000 : 4 500 chacune.
    await waitFor(() => expect(screen.getByText(/4\s?500 F par personne/i)).toBeInTheDocument());
    // Le total reste le total : le partage est un affichage, pas une écriture.
    // (Le plan de salle affiche le même montant — d'où getAllByText.)
    expect(screen.getAllByText('9 000 F').length).toBeGreaterThan(0);
  });

  it('encaisse l\'addition et confirme avec le numéro de facture', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());
    // Le bouton d'encaissement n'existe qu'au-dessus d'une commande non vide :
    // attendre la ligne, sinon le clic part avant qu'il ne soit rendu.
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole('button', { name: /Encaisser 9\s?000 F/ }));

    await waitFor(() => expect(screen.getByText(/Addition encaissée/i)).toBeInTheDocument());
    expect(screen.getByText(/FAC-2026-00042/)).toBeInTheDocument();
    expect(rpcResultats).toContain('close_table_order');
  });

  it('n\'écrit rien dans le stock : une commande n\'est pas une vente', async () => {
    inserts.length = 0;
    definirSalle(table());
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(inserts.length).toBe(1));

    // Aucune écriture sur `products` : le module ne reçoit que les produits en
    // lecture, il n'a même pas de client pour les modifier.
    expect(inserts.every((i) => !('product_id' in i) || i.product_id === undefined)).toBe(true);
    await waitFor(() => {
      expect(screen.getByText(/Stock n'est décrémenté qu'à la clôture/i)).toBeInTheDocument();
    });
  });
});