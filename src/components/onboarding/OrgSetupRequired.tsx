'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSupabase } from '@/components/providers/SupabaseProvider';

export function OrgSetupRequired() {
  const { supabase, user, refreshOrg } = useSupabase();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setLoading(true);
    setError('');
    const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
    // plan n'est pas nommé ici : la colonne vaut déjà 'free' par défaut, et le
    // client n'a plus le privilège de la citer (migration_security.sql). C'est
    // Stripe, en service role, qui écrit dans cette colonne.
    const { error: err } = await supabase.from('organizations').insert({
      id: user.id, name: name.trim(), slug, onboarding_done: false,
    });
    if (err) { setError(err.message); setLoading(false); return; }
    // refreshOrg recharge l'org via le contexte et laisse la SPA reprendre la
    // main. window.location.reload() était une réinitialisation complète de la
    // page pour une simple lecture — c'est ce qui causait le flash d'onboarding
    // (commits 0ed7508 / a215da8).
    await refreshOrg();
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-indigo-600">Configuration requise</h1>
          <p className="text-slate-500 text-sm mt-1">Votre boutique n&apos;a pas été configurée. Entrez son nom pour continuer.</p>
        </div>
        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="org-nom" className="text-sm font-medium text-slate-700">Nom de la boutique</label>
                <input
                  id="org-nom"
                  type="text" value={name} onChange={(e) => setName(e.target.value)} required
                  placeholder="Ex: Épicerie Adjonou"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              {error && <p className="text-red-600 text-sm">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700">
                {loading ? 'Création...' : 'Créer ma boutique'}
              </Button>
            </form>
          </CardContent>
        </Card>
        <button onClick={() => { void supabase.auth.signOut().catch(() => {}); }} className="mt-4 w-full text-sm text-slate-500 hover:text-slate-600 underline">
          Se déconnecter
        </button>
      </div>
    </div>
  );
}
