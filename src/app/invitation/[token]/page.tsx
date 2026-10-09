'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Le token arrive dans un segment d'URL, et non dans un query param : il reste
// ainsi hors des logs d'analyse et des en-têtes Referer.
export default function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [token, setToken] = useState('');
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Next.js expose `params` comme une promesse ; sans cet effet le token
  // n'arriverait jamais et le formulaire resterait bloqué sur « Chargement ».
  useEffect(() => {
    let active = true;
    params.then((p) => {
      if (!active) return;
      setToken(p.token);
      setReady(true);
    });
    return () => { active = false; };
  }, [params]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) { setError('Indiquez votre nom.'); return; }
    if (password.length < 6) { setError('Le mot de passe doit faire au moins 6 caractères.'); return; }
    if (password !== confirm) { setError('Les deux mots de passe ne correspondent pas.'); return; }

    setLoading(true);
    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: name.trim(), password }),
      });
      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setError(json?.error ?? `Erreur serveur (${res.status})`);
        setLoading(false);
        return;
      }

      // Connexion immédiate : l'employé n'a pas à retaper ses identifiants.
      const { error: signInError } = await createClient().auth.signInWithPassword({
        email: json.email,
        password,
      });
      if (signInError) {
        // Le compte existe et le mot de passe est bon, la session n'a simplement
        // pas pu être ouverte ici. La page de connexion le précisera si besoin.
        window.location.href = '/';
        return;
      }
      window.location.href = '/';
    } catch {
      setError('Connexion impossible. Vérifiez votre connexion internet.');
      setLoading(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500';

  if (!ready) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
        <p className="text-sm text-slate-500">Chargement du lien…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">Rejoindre l&apos;équipe</p>
        </div>

        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-1">
                <label htmlFor="inv-nom" className="text-sm font-medium text-slate-700">Votre nom</label>
                <input
                  id="inv-nom"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex : Marie Koffi"
                  autoComplete="name"
                  className={inputClass}
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="inv-password" className="text-sm font-medium text-slate-700">Mot de passe</label>
                <div className="relative">
                  <input
                    id="inv-password"
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="6 caractères minimum"
                    autoComplete="new-password"
                    className={inputClass + ' pr-11'}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 hover:text-slate-600 focus:outline-none"
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label htmlFor="inv-confirm" className="text-sm font-medium text-slate-700">Confirmer</label>
                <input
                  id="inv-confirm"
                  type={show ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Retapez le même mot de passe"
                  autoComplete="new-password"
                  className={inputClass}
                />
              </div>

              {error && <p className="text-red-600 text-sm">{error}</p>}

              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold gap-2"
              >
                {loading ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Création…</>
                ) : (
                  'Rejoindre la boutique'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-500 mt-6">
          <Link href="/connexion" className="hover:text-indigo-600 underline">
            J&apos;ai déjà un compte
          </Link>
        </p>
      </div>
    </main>
  );
}
