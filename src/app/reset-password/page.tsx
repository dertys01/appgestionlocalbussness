'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function ResetPasswordPage() {
  const supabase = createClient();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Course conditionnelle : le SDK detecte la session issue du fragment
    // d'URL (detectSessionInUrl) et peut emettre PASSWORD_RECOVERY *avant*
    // que l'abonnement ci-dessous soit en place. Le listener seul laissait
    // alors l'ecran bloque sur « Validation du lien en cours... ».
    let active = true;
    const markReady = () => { if (active) setReady(true); };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') markReady();
    });

    // Filet : une session de recuperation deja etablie signifie qu'on est pret.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) markReady();
    });

    return () => { active = false; subscription.unsubscribe(); };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('Les mots de passe ne correspondent pas.'); return; }
    if (password.length < 6) { setError('Le mot de passe doit faire au moins 6 caractères.'); return; }
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setError(error.message); setLoading(false); return; }
    router.push('/');
  };

  const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">Nouveau mot de passe</p>
        </div>
        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            {!ready ? (
              <p className="text-sm text-slate-500 text-center py-4">
                Validation du lien en cours...
              </p>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Nouveau mot de passe</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" minLength={6} className={inputClass} />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Confirmer</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required placeholder="••••••••" className={inputClass} />
                </div>
                {error && <p className="text-red-500 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Enregistrement...' : 'Enregistrer le mot de passe'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
