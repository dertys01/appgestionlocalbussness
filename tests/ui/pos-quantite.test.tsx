import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Point de vente — la quantité saisie au poids.
 *
 * Trois défauts trouvés en recette navigateur le 04/10/2026, tous invisibles
 * aux tests existants parce qu'ils passaient tous par `fireEvent.change` avec
 * une valeur déjà numérique — c'est-à-dire par la porte que le navigateur
 * n'ouvre pas.
 *
 * 1. La VIRGULE. Le champ était `type="number"`, qui rejette « 2,5 » : la
 *    saisie est vidé au lieu d'être prise. Or « 2,5 kg » est ce qu'un client
 *    dit et ce qu'un clavier béninois produit — c'est le geste central d'un
 *    commerce de détail au poids (riz, huile, poisson, charbon).
 *
 * 2. L'ERREUR QUI RESTE. « Stock insuffisant » était posé à l'échec et jamais
 *    effacé : le caissier corrigeait son panier, la vente passait, et le
 *    message rouge expliquait encore un refus qui n'avait plus lieu d'être.
 *
 * 3. LA PASTILLE. Le badge de quantité dans le catalogue affichait la quantité
 *    brute — « 2.5 » à côté d'un stock écrit « 48,4 pce ». Deux écritures de
 *    la même quantité dans le même écran, et c'est le reçu du client qui
 *    sortait avec un point.
 */

const { produits, saleRpc, supabase } = vi.hoisted(() => {
  const liste = [
    { id: 'p1', name: 'Riz blanc', price_buy: 400, price_sell: 1200, stock_qty: 50, unit: 'kg' },
    { id: 'p2', name: 'Huile 1L', price_buy: 900, price_sell: 1000, stock_qty: 20, unit: 'L' },
  ];
  const rpc = vi.fn();
  return {
    produits: liste,
    saleRpc: rpc,
    supabase: { from: vi.fn(), rpc, auth: { getUser: vi.fn() } },
  };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'starter',
    loadingProducts: false,
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

const renderPOS = () =>
  render(<POSModule products={produits as unknown as Product[]} onSaleComplete={vi.fn()} />);

/** Champ de quantité d'une ligne du panier. */
const champQuantite = (nom: string) =>
  screen.getByLabelText(`Quantité pour ${nom}`) as HTMLInputElement;

/** Met le riz dans le panier et ouvre le panneau. */
function panierAvecRiz() {
  fireEvent.click(screen.getByText('Riz blanc'));
  return waitFor(() => expect(champQuantite('Riz blanc')).toBeInTheDocument());
}

/**
 * Le bouton d'encaissement. Son libellé porte le total de la vente — c'est la
 * seule chose que le caissier relit avant de prendre l'argent, donc la preuve
 * que la quantité a été comprise comme il l'entendait.
 */
const boutonEncaisser = () =>
  screen
    .getAllByRole('button')
    .find((b) => b.textContent?.trim().startsWith('Encaisser'))!;

beforeEach(() => {
  vi.clearAllMocks();
  saleRpc.mockResolvedValue({
    data: { id: 's1', total_amount: 3000, invoice_number: null },
    error: null,
  });
});

describe('POS — la quantité se saisit avec une virgule', () => {
  it('le champ accepte la virgule sans la vider', async () => {
    renderPOS();
    await panierAvecRiz();

    fireEvent.change(champQuantite('Riz blanc'), { target: { value: '2,5' } });

    // Le champ garde ce qui est tapé, et la ligne vaut bien 2,5 × 1 200.
    // Le total est la preuve : c'est le bouton d'encaissement qui l'annonce.
    await waitFor(() =>
      expect(boutonEncaisser()).toHaveTextContent('3 000 F')
    );
  });

  it('le champ reste utilisable au clavier du téléphone', async () => {
    renderPOS();
    await panierAvecRiz();

    const champ = champQuantite('Riz blanc');
    // inputMode="decimal" ouvre le pavé numérique AVEC la virgule. Un
    // type="number" l'ouvre aussi, mais la virgule y est refusée à la saisie.
    expect(champ).toHaveAttribute('inputMode', 'decimal');
  });

  it('un point décimal fonctionne aussi', async () => {
    renderPOS();
    await panierAvecRiz();

    fireEvent.change(champQuantite('Riz blanc'), { target: { value: '1.5' } });

    await waitFor(() => expect(boutonEncaisser()).toHaveTextContent('1 800 F'));
  });

  it('une saisie illisible est ignorée sans casser la ligne', async () => {
    renderPOS();
    await panierAvecRiz();

    fireEvent.change(champQuantite('Riz blanc'), { target: { value: '2,5' } });
    await waitFor(() => expect(boutonEncaisser()).toHaveTextContent('3 000 F'));

    fireEvent.change(champQuantite('Riz blanc'), { target: { value: 'beaucoup' } });

    // La quantité précédente tient : un panier ne se vide pas parce qu'une
    // touche est mal frappée.
    await waitFor(() => expect(boutonEncaisser()).toHaveTextContent('3 000 F'));
  });

  it('la pastille du catalogue écrit la quantité à la française', async () => {
    renderPOS();
    await panierAvecRiz();

    fireEvent.change(champQuantite('Riz blanc'), { target: { value: '2,5' } });

    // « 2,5 » partout, comme le stock « 50 kg » juste au-dessus. La pastille
    // affichait « 2.5 ».
    await waitFor(() => expect(screen.getByText('2,5')).toBeInTheDocument());
  });
});

describe('POS — le refus d\'encaissement ne survit pas à la correction', () => {
  it('l\'erreur de stock disparaît dès que la quantité redevient faisable', async () => {
    saleRpc.mockResolvedValue({
      error: {
        message:
          'Stock insuffisant pour « Riz blanc » (disponible : 50.000, demandé : 900.000)',
      },
    });
    renderPOS();
    await panierAvecRiz();

    fireEvent.change(champQuantite('Riz blanc'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: /Encaisser/ }));

    await waitFor(() => expect(screen.getByText(/Stock insuffisant/)).toBeInTheDocument());

    // Le caissier corrige : l'avertissement n'a plus lieu d'être.
    fireEvent.change(champQuantite('Riz blanc'), { target: { value: '2' } });

    await waitFor(() => expect(screen.queryByText(/Stock insuffisant/)).not.toBeInTheDocument());
  });

  it('l\'erreur disparaît aussi quand on retire la ligne fautive', async () => {
    saleRpc.mockResolvedValue({
      error: { message: 'Stock insuffisant pour « Riz blanc » (disponible : 50.000)' },
    });
    renderPOS();
    await panierAvecRiz();

    fireEvent.click(screen.getByRole('button', { name: /Encaisser/ }));
    await waitFor(() => expect(screen.getByText(/Stock insuffisant/)).toBeInTheDocument());

    fireEvent.click(screen.getAllByLabelText('Retirer du panier')[0]);

    await waitFor(() => expect(screen.queryByText(/Stock insuffisant/)).not.toBeInTheDocument());
  });
});