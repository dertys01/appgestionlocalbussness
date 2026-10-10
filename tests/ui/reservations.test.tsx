import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Réservations de table.
 *
 * Écriture directe par la table (RLS FOR ALL, pas de RPC) : on vérifie que la
 * création insère bien, et qu'une transition de statut met à jour la ligne.
 */
const h = vi.hoisted(() => {
  const inserts: Record<string, unknown>[] = [];
  const updates: { id: string; payload: Record<string, unknown> }[] = [];
  const tables: Record<string, unknown[]> = { restaurant_reservations: [], restaurant_tables: [] };
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'order', 'limit']) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok);
      q.insert = (payload: Record<string, unknown>) => { inserts.push(payload); return Promise.resolve({ error: null }); };
      q.update = (payload: Record<string, unknown>) => ({
        eq: (_c: string, id: string) => { updates.push({ id, payload }); return Promise.resolve({ error: null }); },
      });
      return q;
    },
  };
  return { supabase, inserts, updates, tables };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, ownerId: 'org-1' }),
}));
vi.mock('@/lib/hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: () => {} }));

import { ReservationsModule } from '@/components/restaurant/ReservationsModule';

beforeEach(() => {
  h.inserts.length = 0;
  h.updates.length = 0;
  h.tables.restaurant_reservations = [];
  h.tables.restaurant_tables = [];
});

describe('ReservationsModule', () => {
  it('affiche l’état vide', async () => {
    render(<ReservationsModule />);
    await waitFor(() => expect(screen.getByText(/Aucune réservation/i)).toBeInTheDocument());
  });

  it('crée une réservation (nom, heure, personnes)', async () => {
    render(<ReservationsModule />);
    await waitFor(() => expect(screen.getByText(/Aucune réservation/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Nouvelle réservation/i }));
    fireEvent.change(screen.getByLabelText('Nom du client (réservation)'), { target: { value: 'M. Kponou' } });
    fireEvent.change(screen.getByLabelText('Date et heure de la réservation'), { target: { value: '2026-10-10T12:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/i }));

    await waitFor(() => expect(h.inserts[0]).toEqual(expect.objectContaining({
      customer_name: 'M. Kponou', party_size: 2, owner_id: 'org-1',
    })));
  });

  it('confirme une réservation en attente', async () => {
    h.tables.restaurant_reservations = [{
      id: 'r1', customer_name: 'M. Kponou', slot_at: '2026-10-10T12:30:00Z',
      party_size: 2, phone: null, table_id: null, status: 'pending', note: null,
    }];
    render(<ReservationsModule />);

    fireEvent.click(await screen.findByRole('button', { name: /Confirmer/i }));
    await waitFor(() => expect(h.updates[0]).toEqual({ id: 'r1', payload: { status: 'confirmed' } }));
  });
});
