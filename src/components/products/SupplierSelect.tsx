'use client';

import { useEffect, useState } from 'react';
import { Plus, Check, Loader2, Truck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import type { Supplier } from '@/types';

interface SupplierSelectProps {
  /** null = aucun fournisseur choisi */
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  /** Relié au <label> du formulaire appelant : sans lui, le sélecteur est
   *  annoncé « combobox » sans nom par un lecteur d'écran. */
  id?: string;
}

/**
 * Sélecteur de fournisseur, avec création à la volée.
 *
 * Un commercçant qui saisit son catalogue ne connaît pas encore ses
 * fournisseurs — il découvre « Grossiste Cokhan » en constituant son stock. Lui
 * faire quitter le formulaire pour créer la fiche le ferait abandonner la
 * saisie ; la création se fait donc ici, en une ligne.
 */
export function SupplierSelect({ value, onChange, disabled, id }: SupplierSelectProps) {
  const { supabase, ownerId, canManageProducts } = useSupabase();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const { data, error: err } = await supabase
      .from('suppliers')
      .select('*')
      .order('name');

    if (err) {
      // Non bloquant : le produit reste saisissable sans fournisseur.
      console.error('[SupplierSelect] chargement', err.message);
      setLoading(false);
      return;
    }
    setSuppliers((data ?? []) as Supplier[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, ownerId]);

  const createInline = async () => {
    const nom = newName.trim();
    if (!nom || !ownerId) return;

    setSaving(true);
    setError('');
    const { data, error: err } = await supabase
      .from('suppliers')
      // .select() renvoie la ligne insérée : pas de rechargement, et le nom
      // saisi devient immédiatement l'option choisie.
      .insert({ user_id: ownerId, name: nom })
      .select()
      .single();

    setSaving(false);

    if (err) {
      setError(
        /blank|not.null|vide/i.test(err.message)
          ? 'Le nom du fournisseur est obligatoire.'
          : `Création impossible : ${err.message}`
      );
      return;
    }

    setSuppliers((prev) =>
      [...prev, data as Supplier].sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    );
    onChange((data as Supplier).id);
    setNewName('');
    setCreating(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0">
          <select
            id={id}
            value={value ?? ''}
            disabled={disabled || loading}
            onChange={(e) => onChange(e.target.value || null)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50 disabled:text-slate-500"
          >
            <option value="">
              {loading ? 'Chargement...' : 'Aucun fournisseur'}
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.phone ? ` — ${s.phone}` : ''}
              </option>
            ))}
          </select>
        </div>

        {canManageProducts && !creating && (
          <button
            type="button"
            onClick={() => { setCreating(true); setError(''); }}
            disabled={disabled}
            title="Créer un fournisseur"
            className="shrink-0 h-[38px] w-[38px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-indigo-400 hover:text-indigo-600 disabled:opacity-40 transition-colors"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>

      {creating && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-2.5 space-y-2">
          <Input
            id={id ? `${id}-nouveau` : undefined}
            aria-label="Nom du nouveau fournisseur"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); createInline(); }
              if (e.key === 'Escape') { setCreating(false); setNewName(''); }
            }}
            placeholder="Ex : Grossiste Cokhan"
            disabled={saving}
            className="bg-white"
          />
          {error && <p className="text-red-600 text-xs">{error}</p>}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={createInline}
              disabled={saving || !newName.trim()}
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 gap-1.5"
            >
              {saving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Création...</>
                : <><Check className="h-3.5 w-3.5" /> Créer et choisir</>}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { setCreating(false); setNewName(''); setError(''); }}
              className="text-slate-500"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {suppliers.length === 0 && !loading && !creating && (
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Truck className="h-3.5 w-3.5" />
          Aucun fournisseur enregistré. Utilisez + pour en créer un.
        </p>
      )}
    </div>
  );
}
