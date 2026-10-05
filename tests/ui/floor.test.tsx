import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * La salle : le plan des tables et la commande ouverte.
 *
 * Ce que ces tests verrouillent : une table libre s'ouvre en UNE commande, et
 * la commande n'écrit RIEN sur le stock. Ce second point est le cœur du Sprint
 * 13 — une commande est une intention de service, pas une vente ; seul le
 * Sprint 14 écrira dans `sales`.
 */

const { salle, inserts, lignesCommande, modificateurs, updates } = vi.hoisted(() => {
  const inserts: Array<Record<string, unknown>> = [];
  return {
    salle: [] as unknown[],
    inserts,
    lignesCommande: [] as unknown[],
    modificateurs: [] as unknown[],
    updates: [] as Array<{ table: string; id: string; payload: Record<string, unknown> }>,
  };
});

// Le plan de salle vient de la vue restaurant_floor, qui répond déjà au tri :
// chaque appel .from('restaurant_floor') rend une promesse résolue.
const chaine = (donnees: unknown, tableCourante = '') => {
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
  c.update = (payload: Record<string, unknown>) => {
    // L'identifiant de la ligne est celui passé au .eq() : c'est ce qui permet
    // d'affirmer « la quantité de CETTE ligne a été corrigée ».
    const lot: { table: string; id: string; payload: Record<string, unknown> }[] = [];
    const chain = {
      eq: (_col: string, id: string) => {
        updates.push({ table: tableCourante, id, payload });
        return chain;
      },
      then: (ok: (v: unknown) => unknown) => ok({ error: null }),
    };
    void lot;
    return chain;
  };
  c.delete = () => ({ eq: async () => ({ error: null }) });
  return c;
};

const { rpcResultats } = vi.hoisted(() => ({ rpcResultats: [] as unknown[] }));

const supabase = {
  from: (table: string) =>
    table === 'restaurant_floor'
      ? chaine(salle, table)
      : table === 'restaurant_order_items'
        ? chaine(lignesCommande, table)
        : table === 'product_modifiers'
          ? chaine(modificateurs, table)
          : chaine({ id: 'x' }, table),
  rpc: vi.fn(async (fn: string) => {
    rpcResultats.push(fn);
    if (fn === 'close_table_order') {
      return {
        data: {
          total_amount: 9200, amount_paid: 9200, tip: 2000,
          invoice_number: 'FAC-2026-00042', sale_id: 'v-1', per_share: 4600,
        },
        error: null,
      };
    }
    return { data: 1, error: null };
  }),
  auth: { getUser: vi.fn() },
};

/**
 * Le rôle de l'utilisateur affiché. Par défaut : le patron. Un test qui veut
 * voir l'écran du caissier le change avant de rendre.
 */
const acteur = { canManageProducts: true, isEmployee: false };

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    get canManageProducts() { return acteur.canManageProducts; },
    get isEmployee() { return acteur.isEmployee; },
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

function definirModificateurs(...ms: unknown[]) {
  modificateurs.length = 0;
  modificateurs.push(...ms);
}

const plat = {
  id: 'l1',
  product_id: 'p1',
  quantity: 2,
  unit_price: 4500,
  extra_price: 0,
  modifier: null,
  note: null,
  status: 'new',
  product: { name: 'Poulet braisé' },
};

beforeEach(() => {
  // Le patron, sauf si un test change le rôle pour voir l'écran du caissier.
  acteur.canManageProducts = true;
  acteur.isEmployee = false;
  updates.length = 0;
  inserts.length = 0;
});

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

  it('propose les options du plat avant de l\'ajouter', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande();
    definirModificateurs(
      { id: 'm1', product_id: 'p1', name: 'Bien cuit', extra_price: 0, is_required: true },
      { id: 'm2', product_id: 'p1', name: 'Double portion', extra_price: 1500, is_required: false },
    );
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getByText(/Fermer le panneau/i)).toBeInTheDocument());

    // Premier clic : sélection, PAS d'insertion. Ajouter d'emblée donnerait une
    // ligne sans cuisson, que le serveur corrigerait à la main.
    // La tuile du plat : nom + prix dans un même bouton. Le libellé accessible
// est le nom seul (le prix est dans un span sans rôle), d'où un sélecteur
// par texte plutôt que par rôle.
fireEvent.click(screen.getAllByText('Poulet braisé')[0]);

    await waitFor(() => expect(screen.getByText('Bien cuit')).toBeInTheDocument());
    expect(screen.getByText('Double portion +1 500 F')).toBeInTheDocument();
    // Aucune ligne de commande écrite : inserts ne contient pour l'instant que
    // l'ouverture de la table.
    expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(0);

    fireEvent.click(screen.getByText('Double portion +1 500 F'));
    fireEvent.click(screen.getByRole('button', { name: /Ajouter à la commande/i }));

    // Le filtre est relu dans waitFor : une liste calculée une fois ne verrait pas
    // l'écriture qui arrive après.
    await waitFor(() => {
      expect(inserts.filter((i) => 'product_id' in i)).toHaveLength(1);
    });
    const ligne = inserts.find((i) => 'product_id' in i)!;
    expect(ligne.modifier).toBe('Double portion');
    expect(ligne.extra_price).toBe(1500);
  });

  it('enregistre le pourboire sans le confondre avec l\'addition', async () => {
    definirSalle(table({ order_id: 'cmd-9', status: 'open' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    await waitFor(() => expect(screen.getAllByText(/Poulet braisé/).length).toBeGreaterThan(1));

    fireEvent.change(screen.getByLabelText(/Pourboire/i), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: /Encaisser 9\s?000 F/ }));

    await waitFor(() => expect(screen.getByText(/Addition encaissée/i)).toBeInTheDocument());
    // 2 000 de pourboire ne changent pas le prix affiché de l'addition.
    expect(screen.getByText(/pourboire 2 000 F \(hors CA\)/)).toBeInTheDocument();
    expect(rpcResultats).toContain('close_table_order');
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

  /**
   * Trouvé en recette navigateur le 05/10/2026.
   *
   * Le formulaire de création de table n'était rendu que dans l'état « aucune
   * table ». La première table créée, il disparaissait — et il n'existait aucun
   * autre chemin pour en ajouter : un maquis de douze tables restait bloqué à une
   * seule, sans message et sans erreur.
   */
  it('permet d\'ajouter une table même quand la salle est déjà installée', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());

    // Le formulaire n'est pas là d'emblée : il prend de la place aux tuiles.
    expect(screen.queryByLabelText(/Nom de la table/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ajouter une table/i }));

    const champ = await screen.findByLabelText(/Nom de la table/i);
    fireEvent.change(champ, { target: { value: 'Terrasse 1' } });
    inserts.length = 0;
    fireEvent.submit(champ.closest('form')!);

    await waitFor(() =>
      expect(inserts.some((i) => i.name === 'Terrasse 1')).toBe(true),
    );
  });

  /**
   * Même recette, même jour. La carte des plats était tronquée à 12 plats sans
   * rien l'annoncer : sur le catalogue d'exemple (17 articles), « Poulet braisé »
   * et « Riz gras » étaient invisibles. Le serveur, qui voit le plat absent de la
   * carte, conclut que la cuisine ne le fait pas.
   */
  it('montre toute la carte, sans troncature cachée', async () => {
    const carte = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `Plat numéro ${String(i).padStart(2, '0')}`,
      sku: `P${i}`,
      price_buy: 500,
      price_sell: 1500,
      stock_qty: 5,
      min_stock_level: 1,
      category: 'Plats',
      unit: 'portion',
    })) as unknown as Product[];

    definirSalle(table({ id: 't1', name: 'Table 1' }));
    render(<FloorModule products={carte} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    await waitFor(() => expect(screen.getByText('Plat numéro 00')).toBeInTheDocument());
    expect(screen.getByText('Plat numéro 19')).toBeInTheDocument();
  });

  /**
   * Trouvé en recette le 05/10/2026.
   *
   * La quantité d'une ligne n'était modifiable qu'AU MOMENT de l'ajout. Une fois
   * le plat dans la commande, on ne pouvait plus que le supprimer — et supprimer ne
   * fusionne pas avec la ligne voisine. « Trois attiékés, puis on s'est trompé de
   * deux » obligeait à tout refaire à la main.
   */
  it('permet de corriger la quantité d\'une ligne déjà entrée', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const champ = await screen.findByLabelText(/Quantité de Poulet braisé/i);
    expect(champ).toHaveValue(2);

    updates.length = 0;
    fireEvent.blur(champ, { target: { value: '5' } });

    await waitFor(() =>
      expect(updates.some((u) => u.payload.quantity === 5 && u.id === 'l1')).toBe(true),
    );
  });

  /**
   * Même recette. Une quantité nulle ou négative casserait l'addition : le total
   * afficherait moins que la somme des lignes, et close_table_order() factories
   * une ligne à prix 0.
   */
  /**
   * Décidé le 05/10/2026.
   *
   * L'écran disait « Demandez l'addition : seul le patron encaisse », et la base
   * refusait l'appel. Mais la caisse, elle, laisse un caissier vendre tous les
   * jours : dans un maquis, le personnel est employé, il ramasse l'argent et ne
   * pouvait pas l'écrire. Le patron devait solder une addition après l'autre.
   *
   * Ce que le geste ne déplace pas : la vente est écrite sur le patron
   * (create_sale() utilise l'identifiant du propriétaire, jamais celui du
   * caissier) et le montant est lu dans les lignes de commande. Voir 24j et
   * suivants dans supabase/tests/migration.test.mjs.
   */
  it('laisse le caissier encaisser une addition', async () => {
    acteur.canManageProducts = false;
    acteur.isEmployee = true;

    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const encaisse = await screen.findByRole('button', { name: /Encaisser 9\s?000 F/ });
    fireEvent.click(encaisse);

    await waitFor(() => expect(screen.getByText(/Addition encaissée/i)).toBeInTheDocument());
    expect(rpcResultats).toContain('close_table_order');
  });

  /**
   * Le seul endroit de la salle qui reste fermé au caissier : choisir les plats
   * servis aujourd'hui est de l'administration, pas de la vente.
   */
  it('ne laisse pas le caissier régler la carte du jour', async () => {
    acteur.canManageProducts = false;
    acteur.isEmployee = true;
    definirModificateurs({ id: 'm1', product_id: 'p1', name: 'Bien cuit', extra_price: 0 });

    definirSalle(table({ id: 't1', name: 'Table 1' }));
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));
    // L'ouverture de la commande est asynchrone : le panneau doit être là avant
    // de cliquer un plat, sinon on cherche un bouton qui n'existe pas encore.
    await screen.findByLabelText(/Chercher un plat/i);
    fireEvent.click(screen.getByText('Poulet braisé'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ajouter à la commande/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Servi le/i)).toBeNull();
  });

  it('refuse une quantité nulle ou négative sur une ligne', async () => {
    definirSalle(table({ id: 't1', name: 'Table 1' }));
    definirCommande(plat);
    render(<FloorModule products={produits} />);

    await waitFor(() => expect(screen.getByText('Table 1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Table 1'));

    const champ = await screen.findByLabelText(/Quantité de Poulet braisé/i);
    updates.length = 0;
    fireEvent.blur(champ, { target: { value: '0' } });

    await waitFor(() =>
      expect(screen.getByText(/quantité doit être un nombre supérieur à zéro/i)).toBeInTheDocument(),
    );
    expect(updates.length).toBe(0);
  });
});