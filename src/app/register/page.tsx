'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

export default function RegisterPage() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // L'inscription passait par supabase.auth.signUp() côté navigateur puis un
  // insert direct dans `organizations` : elle contournait le rate limit de
  // 3 inscriptions/heure d'/api/register, sa validation et son rollback, et
  // échouait dès que la confirmation email était activée (pas de session
  // retournée → insert RLS refusé → compte orphelin). On passe désormais
  // par la même route que LoginPage : /api/register.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (password.length < 6) { setError('Mot de passe : 6 caractères minimum'); return; }
    if (orgName.trim().length < 2) { setError('Le nom de votre boutique est requis'); return; }
    setLoading(true);

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, businessName: orgName.trim() }),
      });

      let json: { error?: string; access_token?: string; refresh_token?: string } = {};
      try { json = await res.json(); } catch { /* corps non JSON */ }

      if (!res.ok) {
        setError(json.error ?? `Erreur lors de la création du compte (HTTP ${res.status}).`);
        return;
      }

      if (json.error) {
        setInfo(json.error);
        return;
      }

      if (!json.access_token || !json.refresh_token) {
        setInfo('Compte créé. Connectez-vous pour continuer.');
        return;
      }

      const { error: sessErr } = await supabase.auth.setSession({
        access_token: json.access_token,
        refresh_token: json.refresh_token,
      });
      if (sessErr) {
        setError(`Compte créé, mais connexion impossible : ${sessErr.message}`);
        return;
      }
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Réseau indisponible. Réessayez.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">Créez votre compte gratuit</p>
        </div>

        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="reg-email" className="text-sm font-medium text-slate-700">
                  Email
                </label>
                <Input
                  id="reg-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="vous@exemple.com"
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="reg-mdp" className="text-sm font-medium text-slate-700">
                  Mot de passe
                </label>
                <div className="relative">
                  <Input
                    id="reg-mdp"
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    placeholder="6 caractères minimum"
                    className="pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd(!showPwd)}
                    aria-label={showPwd ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-r-lg focus:outline-none"
                  >
                    {showPwd ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                <label htmlFor="reg-boutique" className="text-sm font-medium text-slate-700">
                  Nom de votre boutique
                </label>
                <Input
                  id="reg-boutique"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                  placeholder="Ex: Boutique Amen, Super Shop..."
                />
                <p className="text-xs text-slate-500">Ce nom apparaîtra dans vos reçus et rapports</p>
              </div>
              {error && <p className="text-red-600 text-sm">{error}</p>}
              {info && <p className="text-amber-700 text-sm">{info}</p>}
              <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700">
                {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Création...</> : 'Créer ma boutique'}
              </Button>
              <p className="text-center text-sm text-slate-500">
                Déjà un compte ?{' '}
                <Link href="/connexion" className="text-indigo-600 hover:underline font-medium">Se connecter</Link>
              </p>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-500 mt-4">
          Plan gratuit, aucune carte bancaire requise
        </p>
      </div>
    </main>
  );
}
