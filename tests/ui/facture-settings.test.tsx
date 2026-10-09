import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Facture normalisée dans les Paramètres > Boutique.
 *
 * Deux responsabilités de cet écran, vérifiées ici :
 *   • l'IFU ne s'enregistre pas mal : 13 caractères, sinon message clair et
 *     RIEN n'est écrit (un IFU faux produirait des factures mal identifiées) ;
 *   • la carte « Facture normalisée » dit l'état des deux verrous — IFU et
 *     connexion e-MECeF — au lieu de laisser deviner pourquoi la caisse
 *     n'offre pas le bouton.
 */
const { refreshOrg, contexte, update, from, connexion } = vi.hoisted(() => {
  const refreshOrg = vi.fn();
  const contexte = { org: null as Record<string, unknown> | null };
  const update = vi.fn();
  const from = vi.fn(() => ({
    update: (payload: Record<string, unknown>) => {
      update(payload);
      return { eq: vi.fn().mockResolvedValue({ error: null }) };
    },
  }));
  const connexion = { branche: false };
  return { refreshOrg, contexte, update, from, connexion };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: { from, auth: { getSession: vi.fn() } },
    user: { id: 'patron-1', email: 'patron@test.ci' },
    plan: 'free',
    get org() { return contexte.org; },
    refreshOrg,
  }),
}));

vi.mock('@/lib/hooks/useLiaisonMecef', () => ({
  useLiaisonMecef: () => connexion.branche,
}));

import { SettingsModule } from '@/components/settings/SettingsModule';

beforeEach(() => {
  vi.clearAllMocks();
  connexion.branche = false;
  contexte.org = {
    id: 'patron-1',
    name: 'Boutique Test',
    plan: 'free',
    domain: 'retail',
    ui_mode: 'full',
    address: null,
    ifu: null,
    trial_started_at: null,
    trial_ends_at: null,
  };
});

const champIfu = () => screen.getByLabelText(/IFU/);
const boutonEnregistrer = () => screen.getByRole('button', { name: /Enregistrer/ });

async function saisirIfu(valeur: string) {
  render(<SettingsModule />);
  fireEvent.change(champIfu(), { target: { value: valeur } });
  // act enveloppe le clic : la sauvegarde se poursuit en async, et ses
  // mises à jour d'état doivent rester dans l'act.
  await act(async () => {
    fireEvent.click(boutonEnregistrer());
  });
}

describe('Boutique — IFU validé avant enregistrement', () => {
  it('un IFU trop court est refusé, sans écriture en base', async () => {
    await saisirIfu('123456789012'); // 12 caractères

    expect(
      await screen.findByText(/comporte 13 caractères/),
    ).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(refreshOrg).not.toHaveBeenCalled();
  });

  it('un IFU à 13 caractères s’enregistre et réinitialise le message', async () => {
    await saisirIfu('AB12345678901');

    await waitFor(() => expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ ifu: 'AB12345678901' }),
    ));
    await waitFor(() =>
      expect(screen.getByText('Modifications enregistrées')).toBeInTheDocument());
  });

  it('un champ vide s’enregistre en null (IFU jamais obligatoire ailleurs)', async () => {
    await saisirIfu('   ');

    await waitFor(() => expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ ifu: null }),
    ));
  });
});

describe('Boutique — carte « Facture normalisée »', () => {
  it('IFU absent et connexion fermée : les deux lignes le disent', () => {
    connexion.branche = false;
    render(<SettingsModule />);

    expect(screen.getByText(/IFU non enregistré/)).toBeInTheDocument();
    expect(screen.getByText(/Connexion au service de facturation/)).toBeInTheDocument();
    expect(screen.getByText(/reçu, lui, reste toujours disponible/)).toBeInTheDocument();
  });

  it('IFU enregistré et connexion ouverte : les deux lignes passent au vert', () => {
    contexte.org = { ...(contexte.org as object), ifu: 'AB12345678901' };
    connexion.branche = true;
    render(<SettingsModule />);

    expect(screen.getByText('IFU enregistré.')).toBeInTheDocument();
    expect(screen.getByText('Connexion au service de facturation ouverte.')).toBeInTheDocument();
    expect(screen.queryByText(/IFU non enregistré/)).toBeNull();
  });

  it('un IFU existant mais invalide affiche le verrou, pas la coche', () => {
    contexte.org = { ...(contexte.org as object), ifu: '123' };
    render(<SettingsModule />);

    expect(screen.getByText(/IFU non enregistré/)).toBeInTheDocument();
    expect(screen.queryByText('IFU enregistré.')).toBeNull();
  });
});
