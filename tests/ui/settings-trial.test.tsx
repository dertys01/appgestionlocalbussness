import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Onglet Abonnement — la carte d'essai de 14 jours.
 *
 * Quatre états, tous pilotés par les COLONNES de la boutique (jamais par le
 * plan effectif, qui pendant l'essai vaut déjà 'starter' et ne dirait plus
 * jamais « éligible ») :
 *   • jamais commencé  → le bouton, qui n'appelle que le RPC ;
 *   • en cours        → la date de fin, pas de bouton ;
 *   • expiré          → dit qu'il est terminé (il ne se relance jamais) ;
 *   • boutique payante→ rien du tout.
 */
const { supabase, rpc, refreshOrg, contexte } = vi.hoisted(() => {
  const rpc = vi.fn();
  const refreshOrg = vi.fn();
  const contexte = {
    plan: 'free' as string,
    org: null as Record<string, unknown> | null,
  };
  return { rpc, refreshOrg, contexte, supabase: { rpc } };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    user: { id: 'patron-1', email: 'patron@test.ci' },
    get plan() { return contexte.plan; },
    get org() { return contexte.org; },
    refreshOrg,
  }),
}));

import { SettingsModule } from '@/components/settings/SettingsModule';

const jours = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

function orgLibre(essai: Partial<{ trial_started_at: string | null; trial_ends_at: string | null }> = {}) {
  return {
    id: 'patron-1',
    name: 'Boutique Test',
    plan: 'free',
    domain: 'retail',
    ui_mode: 'full',
    address: null,
    ifu: null,
    trial_started_at: null,
    trial_ends_at: null,
    ...essai,
  };
}

function ouvrirAbonnement() {
  render(<SettingsModule />);
  fireEvent.click(screen.getByText(/Abonnement/));
}

beforeEach(() => {
  vi.clearAllMocks();
  contexte.plan = 'free';
  contexte.org = orgLibre();
  rpc.mockResolvedValue({ error: null });
});

describe('Essai de 14 jours — carte d’abonnement', () => {
  it('jamais commencé : le bouton appelle le RPC puis relit la boutique', async () => {
    ouvrirAbonnement();

    expect(screen.getByText(/Essayer Starter pendant 14 jours/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Démarrer l.essai/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('start_free_trial'));
    await waitFor(() => expect(refreshOrg).toHaveBeenCalled());
    // L'écran n'a rien anticipé : le plan bascule par refreshOrg, pas ici.
    expect(contexte.plan).toBe('free');
  });

  it('un refus de la base s’affiche au lieu de faire croire à un essai démarré', async () => {
    rpc.mockResolvedValue({
      error: { message: "L'essai gratuit de 14 jours n'est proposé qu'une fois par boutique." },
    });
    ouvrirAbonnement();

    fireEvent.click(screen.getByRole('button', { name: /Démarrer l.essai/ }));

    await waitFor(() =>
      expect(screen.getByText(/une fois par boutique/)).toBeInTheDocument());
    expect(refreshOrg).not.toHaveBeenCalled();
  });

  it('en cours : la date de fin et le compte à rebours, sans bouton', () => {
    // Plan EFFECTIF starter (ce que le provider donne pendant l'essai) —
    // c'est bien l'état des colonnes qui pilote la carte.
    contexte.plan = 'starter';
    contexte.org = orgLibre({ trial_started_at: jours(-4), trial_ends_at: jours(10) });
    ouvrirAbonnement();

    expect(screen.getByText(/Essai Starter en cours/)).toBeInTheDocument();
    expect(screen.getByText(/se termine le/)).toBeInTheDocument();
    expect(screen.getByText(/jours restants/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Démarrer l.essai/ })).toBeNull();
  });

  it('expiré : dit les choses, et ne propose jamais un essai qui échouerait', () => {
    contexte.org = orgLibre({ trial_started_at: jours(-20), trial_ends_at: jours(-6) });
    ouvrirAbonnement();

    expect(screen.getByText(/votre essai de 14 jours est terminé/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Démarrer l.essai/ })).toBeNull();
  });

  it('boutique payante : aucune carte d’essai', () => {
    contexte.plan = 'starter';
    contexte.org = { ...orgLibre({ trial_started_at: jours(-4), trial_ends_at: jours(10) }), plan: 'starter' };
    ouvrirAbonnement();

    expect(screen.queryByText(/Essai Starter en cours/)).toBeNull();
    expect(screen.queryByText(/Essayer Starter/)).toBeNull();
  });
});
