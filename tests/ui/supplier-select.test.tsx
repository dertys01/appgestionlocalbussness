import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Sélecteur de fournisseur, avec création à la volée.
 *
 * Un commerçant qui remplit son catalogue découvre ses fournisseurs en le
 * faisant : créer la fiche sans quitter le formulaire est le geste normal. On
 * verrouille que la création écrit bien `user_id` + `name`, sélectionne la
 * nouvelle fiche, et que l'erreur est traduite.
 */

const h = vi.hoisted(() => {
  const state = {
    suppliers: [] as Array<Record<string, unknown>>,
    newSupplier: { id: 'new-id', name: 'Cokhan', phone: null } as Record<string, unknown>,
    insertError: null as { message: string } | null,
    inserts: [] as Array<Record<string, unknown>>,
    canManage: true,
  };
  const builder = () => {
    const ctx = { op: '' };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.insert = (p: Record<string, unknown>) => { state.inserts.push(p); ctx.op = 'insert'; return b; };
    b.single = () => Promise.resolve(ctx.op === 'insert' ? { data: state.newSupplier, error: state.insertError } : { data: null, error: null });
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: state.suppliers, error: null }).then(ok);
    return b;
  };
  const supabase = { from: () => builder() };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase, ownerId: 'org-1', canManageProducts: h.state.canManage,
    org: { domain: 'retail' },
  }),
}));

import { SupplierSelect } from '@/components/products/SupplierSelect';

beforeEach(() => {
  h.state.suppliers = [];
  h.state.newSupplier = { id: 'new-id', name: 'Cokhan', phone: null };
  h.state.insertError = null;
  h.state.inserts = [];
  h.state.canManage = true;
});

describe('SupplierSelect', () => {
  it('charge les fournisseurs et gère la sélection et le vide', async () => {
    h.state.suppliers = [{ id: 's1', name: 'Cokhan', phone: '97000000' }];
    const onChange = vi.fn();
    render(<SupplierSelect id="four" value={null} onChange={onChange} />);

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(2)); // « Aucun » + 1
    expect(select.options[1].text).toBe('Cokhan (97000000)');

    fireEvent.change(select, { target: { value: 's1' } });
    expect(onChange).toHaveBeenCalledWith('s1');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('invite à créer quand la liste est vide', async () => {
    render(<SupplierSelect value={null} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Aucun fournisseur enregistré/)).toBeInTheDocument());
  });

  it('crée un fournisseur à la volée et le sélectionne', async () => {
    const onChange = vi.fn();
    render(<SupplierSelect value={null} onChange={onChange} />);

    // Chargement terminé AVANT de créer : sinon sa résolution tardive
    // réécrirait la liste (le composant relit la liste au montage).
    await screen.findByText(/Aucun fournisseur enregistré/);

    fireEvent.click(screen.getByTitle('Créer un fournisseur'));
    fireEvent.change(screen.getByLabelText('Nom du nouveau fournisseur'), { target: { value: 'Cokhan' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer et choisir/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('new-id'));
    expect(h.state.inserts[0]).toEqual({ user_id: 'org-1', name: 'Cokhan' });
    // La nouvelle fiche rejoint la liste sans rechargement.
    await waitFor(() => {
      const sel = screen.getByRole('combobox') as HTMLSelectElement;
      expect([...sel.options].map((o) => o.text)).toEqual(['Aucun fournisseur', 'Cokhan']);
    });
  });

  it('traduit un nom refusé par la base', async () => {
    h.state.insertError = { message: 'null value in column "name" violates not-null constraint' };
    render(<SupplierSelect value={null} onChange={() => {}} />);

    fireEvent.click(screen.getByTitle('Créer un fournisseur'));
    fireEvent.change(screen.getByLabelText('Nom du nouveau fournisseur'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer et choisir/ }));

    await waitFor(() => expect(screen.getByText('Le nom du fournisseur est obligatoire.')).toBeInTheDocument());
  });

  it('un caissier ne peut pas créer de fournisseur', async () => {
    h.state.canManage = false;
    render(<SupplierSelect value={null} onChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Aucun fournisseur enregistré/)).toBeInTheDocument());
    expect(screen.queryByTitle('Créer un fournisseur')).toBeNull();
  });
});
