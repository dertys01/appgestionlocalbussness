import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Reprendre la dernière vente.
 *
 * Fonction standard de tout POS du commerce (« repeat last transaction »).
 * Son intérêt ici est concret : un client qui revient pour un second GSM
 * identique, et un caissier qui resélectionne tout à la main.
 *
 * La règle qui compte : ça AJOUTE, ça n'écrase jamais. Un raccourci capable de
 * vider une vente en cours serait plus dangereux que le temps qu'il fait
 * gagner.
 */
const { products, from, rpc, supabase } = vi.hoisted(() => {
  const produits = [
    { id: 'a17-6', name: 'A17 128/6', category: 'smartphones', price_buy: 93000, price_sell: 108000, stock_qty: 10, min_stock_level: 1 },
    { id: 'coque', name: 'Coque A17', category: 'smartphones', price_buy: 2000, price_sell: 3500, stock_qty: 20, min_stock_level: 1 },
    { id: 'riz', name: 'RIZ', category: 'cereal', price_buy: 1200, price_sell: 1500, stock_qty: 5, min_stock_level: 1 },
  ];
  const from = vi.fn();
  const rpc = vi.fn();
  return {
    products: produits,
    from,
    rpc,
    supabase: { from, rpc, auth: { getUser: vi.fn() } },
  };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'pro',
    org: null,
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

/** Chaîne PostgREST chaînable, filtrée par table. */
function chaine(donnees: unknown[] = []) {
  let filtre: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) {
    q[m] = (...args: unknown[]) => {
      if (m === 'eq') filtre = { ...filtre, eq: args[0] };
      if (m === 'limit') filtre = { ...filtre, limit: args[0] };
      return q;
    };
  }
  q.then = (ok: unknown, ko: unknown) =>
    Promise.resolve({ data: donnees, error: null }).then(ok as never, ko as never);
  return q;
}

const VENTE = { id: 'v1', total_amount: 219500 };
const LIGNES = [
  { product_id: 'a17-6', quantity: 2, unit_price: 108000 },
  { product_id: 'coque', quantity: 1, unit_price: 3500 },
];

/**
 * « Base » mutable : create_sale déplace la dernière vente au moment de
 * l'encaissement, comme le ferait le serveur. Les tests qui veulent un état
 * fixe surchargent `from` eux-mêmes et ignorent ces deux variables.
 */
let venteCourante = VENTE;
let lignesCourantes = LIGNES;

/**
 * Stockage mémoire : jsdom ne fournit pas `localStorage` ici (c'est pour ça
 * que le composant le lit en défensif). Le stub prouve le vrai chemin —
 * lecture à chaque montage, écriture au X — au lieu de le court-circuiter.
 */
const sac = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k: string) => (sac.has(k) ? sac.get(k)! : null),
    setItem: (k: string, v: string) => { sac.set(k, v); },
    removeItem: (k: string) => { sac.delete(k); },
    clear: () => sac.clear(),
  },
  configurable: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Le X du bandeau survit dans le stockage : sans ce ménage, un test
  // polluerait le suivant avec une vente fermée ailleurs.
  sac.clear();
  venteCourante = VENTE;
  lignesCourantes = LIGNES;
  rpc.mockResolvedValue({ data: [], error: null });
  from.mockImplementation((table: string) => {
    if (table === 'sales') return chaine([venteCourante]);
    if (table === 'sale_items') return chaine(lignesCourantes);
    return chaine([]);
  });
});

const renderPOS = () =>
  render(<POSModule products={products as unknown as Product[]} onSaleComplete={vi.fn()} />);

/**
 * Clique la carte produit de la grille, et non la ligne du panier qui porte le
 * même nom : une fois l'article ajouté, le nom apparaît deux fois.
 */
function ajouterAuPanier(nom: string, fois = 1) {
  for (let i = 0; i < fois; i++) {
    fireEvent.click(screen.getAllByText(nom)[0]);
  }
}

const boutonReprendre = () =>
  screen.getByRole('button', { name: /Ajouter au panier les \d+ articles de la dernière vente/ });

describe('POS — reprendre la dernière vente', () => {
  it('le bouton apparaît avec le nombre d’articles et le total', async () => {
    renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    // 2 A17 + 1 coque = 219 500 F, cohérent avec la vente relue.
    expect(boutonReprendre().textContent).toContain('2 articles');
  });

  it('cliquer ajoute les articles au panier', async () => {
    renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(boutonReprendre());

    // 2 × 108 000 + 3 500 = 219 500, en 3 unités : la barre compte les
    // unités, pas les lignes de panier.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /3 articles, total/ })).toBeInTheDocument()
    );
  });

  it('fusionne avec un panier déjà rempli au lieu de l’écraser', async () => {
    renderPOS();
    // Le caissier a déjà ajouté 3 RIZ.
    ajouterAuPanier('RIZ', 3);
    await waitFor(() => expect(screen.getByRole('button', { name: /3 articles, total/ })).toBeInTheDocument());

    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(boutonReprendre());

    // 3 RIZ + 2 A17 + 1 coque = 6 unités. Si la reprise remplaçait, il en
    // resterait 3 : c'est le test qui protège le panier en cours.
    await waitFor(() => expect(screen.getByRole('button', { name: /6 articles, total/ })).toBeInTheDocument());
  });

  it('ne propose rien quand le catalogue est vide de ventes', async () => {
    from.mockImplementation((table: string) => chaine(table === 'sales' ? [] : []));
    renderPOS();
    await waitFor(() => expect(screen.getByText('RIZ')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /dernière vente/ })).toBeNull();
  });

  it('retire les lignes dont le produit a quitté le catalogue, sans planter', async () => {
    from.mockImplementation((table: string) => {
      if (table === 'sales') return chaine([VENTE]);
      // « disparu » n'est plus au catalogue : la ligne doit être écartée.
      if (table === 'sale_items') {
        return chaine([
          { product_id: 'a17-6', quantity: 1, unit_price: 108000 },
          { product_id: 'disparu', quantity: 4, unit_price: 9000 },
        ]);
      }
      return chaine([]);
    });
    renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    expect(boutonReprendre().textContent).toContain('retiré du catalogue');
    fireEvent.click(boutonReprendre());
    await waitFor(() => expect(screen.getByRole('button', { name: /1 article, total/ })).toBeInTheDocument());
  });

  it('ne peut pas dépasser le stock', async () => {
    // RIZ : stock 5, la dernière vente en prenait 2 et le caissier en a déjà 4.
    from.mockImplementation((table: string) => {
      if (table === 'sales') return chaine([{ id: 'v2', total_amount: 3000 }]);
      if (table === 'sale_items') return chaine([{ product_id: 'riz', quantity: 2, unit_price: 1500 }]);
      return chaine([]);
    });
    renderPOS();
    ajouterAuPanier('RIZ', 4);
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(boutonReprendre());

    // 4 + 2 = 6, mais le stock est de 5 : la ligne s'arrête à 5, sinon c'est
    // create_sale() qui refuse au dernier moment et la vente est perdue.
    await waitFor(() => expect(screen.getByRole('button', { name: /5 articles, total/ })).toBeInTheDocument());
  });

  it('après encaissement, le bandeau passe à la vente qu’on vient de valider', async () => {
    // Régression : le bandeau n'était rafraîchi qu'indirectement — un
    // rechargement du catalogue côté parent changeait la référence de
    // `products`, ce qui relançait l'effet de chargement. Si ce rechargement
    // n'arrivait pas (échec, retard, parent qui ne le fait pas), l'ancienne
    // vente restait affichée alors que la nouvelle était déjà validée et
    // clôturée — exactement le symptôme vu en caisse.
    rpc.mockImplementation(async (nom: string) => {
      if (nom !== 'create_sale') return { data: [], error: null };
      // create_sale a commité : la vente vient de devenir la dernière.
      venteCourante = { id: 'v2', total_amount: 1500 };
      lignesCourantes = [{ product_id: 'riz', quantity: 1, unit_price: 1500 }];
      return { data: { id: 'v2', total_amount: 1500, invoice_number: 'FA-0007' }, error: null };
    });
    supabase.auth.getUser = vi.fn().mockResolvedValue({ data: { user: null } });

    renderPOS();
    // Le bandeau commence sur l'ancienne vente : 2 A17 + 1 coque.
    await waitFor(() => expect(boutonReprendre().textContent).toContain('2 articles'));

    ajouterAuPanier('RIZ');
    fireEvent.click(await screen.findByRole('button', { name: /Encaisser/ }));

    // Le reçu s'ouvre : la vente est validée. On le clôt, comme le caissier.
    fireEvent.click(await screen.findByRole('button', { name: 'Fermer' }));

    // Le bandeau bascule sur la nouvelle vente, et il n'y a AUCUN
    // rechargement du catalogue derrière : `onSaleComplete` est un no-op
    // dans ce test et le prop `products` n'a pas bougé. Si le bandeau bouge
    // quand même, c'est qu'il se rafraîchit lui-même.
    await waitFor(() => expect(boutonReprendre().textContent).toContain('1 article'));
    expect(boutonReprendre().textContent).toMatch(/1\s?500\s?F/);
  });

  it('le bouton X ferme la proposition pour cette vente-là, même après remontage', async () => {
    // Régression vue en boutique : la fermeture était un booléen remis à zéro
    // à chaque remontage — la caisse étant démontée hors de son onglet,
    // changer d'onglet puis revenir faisait revenir le bandeau, encore et
    // encore. La fermeture est attachée à la vente et survit en localStorage.
    const vue = renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole('button', { name: 'Masquer la reprise de la dernière vente' })
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /dernière vente/ })).toBeNull());

    // Changement d'onglet simulé : la caisse est démontée puis remontée, la
    // même vente est toujours la dernière — le bandeau ne revient pas.
    vue.unmount();
    renderPOS();
    await waitFor(() => expect(screen.getByText('RIZ')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: /Ajouter au panier les \d+ articles de la dernière vente/ })
    ).not.toBeInTheDocument();
  });

  it('une nouvelle vente réaffiche le bandeau (la fermeture valait pour l’ancienne)', async () => {
    // Le pendant du test précédent : fermer n'est pas bannir la fonction.
    // Une vente différente a un autre identifiant — le bandeau fait son
    // travail et propose la dernière vente, qui a changé.
    const vue = renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    fireEvent.click(
      screen.getByRole('button', { name: 'Masquer la reprise de la dernière vente' })
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: /dernière vente/ })).toBeNull());

    venteCourante = { id: 'v-nouvelle', total_amount: 1500 };
    lignesCourantes = [{ product_id: 'riz', quantity: 1, unit_price: 1500 }];
    // Deux caisses montées à la fois feraient doublon à l'écran : on démonte
    // avant de remonter, comme un changement d'onglet aller-retour.
    vue.unmount();
    const vue2 = renderPOS();
    await waitFor(() => expect(boutonReprendre()).toBeInTheDocument());
    expect(boutonReprendre().textContent).toContain('1 article');
    vue2.unmount();
  });
});
