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

  const [step, setStep] = useState<'account' | 'org'>('account');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [userId, setUserId] = useState('');

  const handleAccountStep = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Mot de passe : 6 caractères minimum'); return; }
    setLoading(true);

    const { data, error: signUpErr } = await supabase.auth.signUp({ email, password });
    if (signUpErr) {
      setError(signUpErr.message.includes('already registered')
        ? 'Cet email est déjà utilisé'
        : signUpErr.message);
      setLoading(false);
      return;
    }

    if (data.user) {
      setUserId(data.user.id);
      setStep('org');
    }
    setLoading(false);
  };

  const handleOrgStep = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!orgName.trim()) { setError('Le nom de votre boutique est requis'); return; }
    setLoading(true);

    const slug = orgName.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      + '-' + userId.slice(0, 8);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: orgErr } = await (supabase as any)
      .from('organizations')
      .insert({
        id: userId,
        name: orgName.trim(),
        slug,
        // plan absent volontairement : colonne à 'free' par défaut, et le
        // client n'a plus le privilège de la citer (migration_security.sql).
        onboarding_done: false,
      });

    if (orgErr) {
      // L'org existe déjà (ex: double submit) → on continue quand même
      if (!orgErr.message.includes('duplicate')) {
        setError(orgErr.message);
        setLoading(false);
        return;
      }
    }

    router.push('/');
    setLoading(false);
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-indigo-600">GestionLocal</h1>
          <p className="text-slate-500 mt-1">
            {step === 'account' ? 'Créez votre compte gratuit' : 'Nommez votre boutique'}
          </p>
        </div>

        {/* Indicateur d'étapes */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {(['account', 'org'] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                step === s ? 'bg-indigo-600 text-white' :
                (i === 0 && step === 'org') ? 'bg-emerald-700 text-white' :
                'bg-slate-200 text-slate-500'
              }`}>
                {i === 0 && step === 'org' ? '✓' : i + 1}
              </div>
              {i === 0 && <div className="h-px w-8 bg-slate-200" />}
            </div>
          ))}
        </div>

        <Card className="border-slate-200 shadow-md">
          <CardContent className="p-6">
            {step === 'account' ? (
              <form onSubmit={handleAccountStep} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Email</label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="vous@exemple.com"
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Mot de passe</label>
                  <div className="relative">
                    <Input
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
                {error && <p className="text-red-600 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700">
                  {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Création...</> : 'Continuer'}
                </Button>
                <p className="text-center text-sm text-slate-500">
                  Déjà un compte ?{' '}
                  <Link href="/" className="text-indigo-600 hover:underline font-medium">Se connecter</Link>
                </p>
              </form>
            ) : (
              <form onSubmit={handleOrgStep} className="space-y-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Nom de votre boutique</label>
                  <Input
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    placeholder="Ex: Boutique Amen, Super Shop..."
                    autoFocus
                  />
                  <p className="text-xs text-slate-500">Ce nom apparaîtra dans vos reçus et rapports</p>
                </div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700">
                  {loading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Création...</> : 'Créer ma boutique'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-500 mt-4">
          Plan gratuit — aucune carte bancaire requise
        </p>
      </div>
    </main>
  );
}
