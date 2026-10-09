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
  const [checked, setChecked] = useState(false);
  // Sans affichage en clair, un commerçant qui se trompe de frappe ne voit rien
  // du tout et suppose que le clavier est defaillant. Le reveal est attendu sur
  // un ecran de creation de mot de passe, et le risque est nul : c'est
  // l'utilisateur lui-meme qui saisit la valeur.
  const [showPassword, setShowPassword] = useState(false);

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

    // Le filet n'acceptait QUE l'événement PASSWORD_RECOVERY auparavant :
    // n'importe quelle session active débloquait le changement de mot de
    // passe sans prouver la possession du jeton de récupération. On exige
    // désormais l'événement, ou une session issue d'un lien de récupération
    // (fragment d'URL qui contient type=recovery).
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session && window.location.hash.includes('type=recovery')) markReady();
      else setChecked(true);
    });

    return () => { active = false; subscription.unsubscribe(); };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('Les mots de passe ne correspondent pas.'); return; }
    if (password.length < 6) { setError('Le mot de passe doit faire au moins 6 caractères.'); return; }
    setLoading(true);
    setError('');
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) { setError(error.message); return; }
      router.push('/');
    } catch (err) {
      // updateUser peut rejeter (réseau) : sans ce catch, le bouton restait
      // bloqué sur « Enregistrement… ».
      setError(err instanceof Error ? err.message : 'Mise à jour impossible. Réessayez.');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">Nouveau mot de passe</p>
        </div>
        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            {!ready ? (
              checked ? (
                <p className="text-sm text-red-600 text-center py-4">
                  Ce lien de récupération est invalide ou a expiré. Refaites une demande depuis la page de connexion.
                </p>
              ) : (
                <p className="text-sm text-slate-500 text-center py-4">
                  Validation du lien en cours...
                </p>
              )
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="reset-password" className="text-sm font-medium text-slate-700">Nouveau mot de passe</label>
                  <div className="relative">
                    <input
                      id="reset-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      placeholder="6 caractères minimum"
                      minLength={6}
                      autoComplete="new-password"
                      className={inputClass + ' pr-11'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 hover:text-slate-600 focus:outline-none"
                    >
                      {showPassword ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor="reset-confirm" className="text-sm font-medium text-slate-700">Confirmer</label>
                  <input
                    id="reset-confirm"
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    placeholder="Retapez le même mot de passe"
                    minLength={6}
                    autoComplete="new-password"
                    className={inputClass}
                  />
                </div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 font-semibold">
                  {loading ? 'Enregistrement...' : 'Enregistrer le mot de passe'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
