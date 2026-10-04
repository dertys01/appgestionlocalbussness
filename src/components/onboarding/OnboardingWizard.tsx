'use client';

import { useState } from 'react';
import { Package, Users, CheckCircle, Loader2, ArrowRight, Store, UtensilsCrossed } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { logActivity } from '@/lib/utils/activity';
import { normalizeDomain, DOMAIN_LABELS, DOMAIN_DESCRIPTIONS, type Domain } from '@/lib/modules';

interface OnboardingWizardProps {
  onComplete: () => void;
}

type Step = 'domain' | 'welcome' | 'first-product' | 'invite' | 'done';

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { supabase, user, ownerId, org, refreshOrg } = useSupabase();
  const [step, setStep] = useState<Step>('domain');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Le domaine décide des modules affichés (src/lib/modules.ts). La question
  // vient AVANT la configuration : c'est elle qui change l'interface, la
  // découvrir après avoir créé dix produits serait une fausse information.
  const currentDomain = normalizeDomain(org?.domain);
  const [domain, setDomain] = useState<Domain>(currentDomain);
  // Un maquis n'est pas une boutique : deux mots d'écart, et l'écran ne parle
  // plus du mauvais métier à celui qui le lit.
  const etablissement = domain === 'restaurant' ? 'votre établissement' : 'votre boutique';

  // Produit
  const [productName, setProductName] = useState('');
  const [productPrice, setProductPrice] = useState('');
  const [productStock, setProductStock] = useState('');

  const handleSkipOrComplete = async () => {
    await markDone();
    onComplete();
  };

  const markDone = async () => {
    await supabase
      .from('organizations')
      .update({ onboarding_done: true } as Record<string, unknown>)
      .eq('id', ownerId!);
    await refreshOrg();
  };

  // Le domaine s'écrit comme le reste de l'onboarding : le patron est le seul
  // à tenir la ligne sur organizations (RLS), et c'est le seul écran qui
  // l'ait sous les yeux.
  const handleDomain = async (d: Domain) => {
    setLoading(true);
    setError('');
    const { error: err } = await supabase
      .from('organizations')
      .update({ domain: d } as Record<string, unknown>)
      .eq('id', ownerId!);
    setLoading(false);
    if (err) { setError(err.message); return; }
    setDomain(d);
    await refreshOrg();
    setStep('welcome');
  };

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!productName || !productPrice) { setError('Nom et prix requis'); return; }

    setLoading(true);
    const { error: err } = await supabase.from('products').insert({
      user_id: ownerId,
      name: productName.trim(),
      price_buy: 0,
      price_sell: parseFloat(productPrice) || 0,
      // parseFloat et non parseInt : stock_qty est NUMERIC depuis la migration
      // « vente au poids ». Ici l'unité vaut 'pce' et le navigateur bloque les
      // décimales (step par défaut = 1), mais on ne fait pas dépendre la
      // valeur en base d'un contrôle de formulaire.
      stock_qty: parseFloat(productStock) || 0,
      min_stock_level: 5,
    });

    if (err) { setError(err.message); setLoading(false); return; }

    if (user && ownerId) {
      await logActivity({
        ownerId,
        actorId: user.id,
        actorEmail: user.email ?? '',
        actorName: user.email,
        action: 'product_add',
        description: `Premier produit ajouté : ${productName}`,
      });
    }

    setLoading(false);
    setStep('invite');
  };

  const steps = [
    { id: 'domain', label: 'Activité' },
    { id: 'welcome', label: 'Bienvenue' },
    { id: 'first-product', label: 'Produit' },
    { id: 'invite', label: 'Équipe' },
    { id: 'done', label: 'Terminé' },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 to-slate-100">
      <div className="w-full max-w-md">
        {/* Stepper */}
        <div className="flex items-center justify-center gap-1 mb-8">
          {steps.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <div className={`flex items-center justify-center h-7 w-7 rounded-full text-xs font-bold transition-colors ${
                i < stepIndex ? 'bg-emerald-700 text-white' :
                i === stepIndex ? 'bg-indigo-600 text-white' :
                'bg-slate-200 text-slate-500'
              }`}>
                {i < stepIndex ? '✓' : i + 1}
              </div>
              {i < steps.length - 1 && (
                <div className={`h-px w-6 mx-1 ${i < stepIndex ? 'bg-emerald-400' : 'bg-slate-200'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-8 space-y-6">
          {/* ── DOMAINE ── */}
          {step === 'domain' && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-xl font-bold text-slate-800">Quelle est votre activité&nbsp;?</h2>
                <p className="text-sm text-slate-500 mt-2">
                  L&apos;interface s&apos;adapte à votre métier. Vous pourrez changer d&apos;activité
                  plus tard dans les réglages, sans rien perdre.
                </p>
              </div>

              <div className="grid gap-3">
                {(['retail', 'restaurant'] as const).map((d) => {
                  const Icon = d === 'retail' ? Store : UtensilsCrossed;
                  const actif = domain === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => handleDomain(d)}
                      disabled={loading}
                      aria-pressed={actif}
                      className={`flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors disabled:opacity-60 ${
                        actif ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
                      }`}
                    >
                      <Icon className={`h-6 w-6 shrink-0 mt-0.5 ${actif ? 'text-indigo-600' : 'text-slate-400'}`} />
                      <span>
                        <span className="block text-sm font-semibold text-slate-800">
                          {DOMAIN_LABELS[d]}
                        </span>
                        <span className="block text-xs text-slate-500 mt-0.5">
                          {DOMAIN_DESCRIPTIONS[d]}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {error && <p className="text-red-600 text-sm text-center">{error}</p>}
            </div>
          )}

          {/* ── WELCOME ── */}
          {step === 'welcome' && (
            <div className="text-center space-y-4">
              <div className="h-16 w-16 rounded-2xl bg-indigo-100 flex items-center justify-center mx-auto">
                <span className="text-3xl">👋</span>
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-800">
                  Bienvenue sur GestionLocal,<br />
                  <span className="text-indigo-600">{org?.name ?? etablissement}</span> !
                </h2>
                <p className="text-slate-500 text-sm mt-2">
                  Configurons {etablissement} en 2 minutes. Vous pouvez passer chaque étape si vous préférez.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-left pt-2">
                <div className="rounded-xl bg-slate-50 p-3 space-y-1">
                  <Package className="h-5 w-5 text-indigo-600" />
                  <p className="text-sm font-medium text-slate-700">Gérez votre stock</p>
                  <p className="text-xs text-slate-500">Produits, catégories, alertes</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3 space-y-1">
                  <Users className="h-5 w-5 text-emerald-700" />
                  <p className="text-sm font-medium text-slate-700">Votre équipe</p>
                  <p className="text-xs text-slate-500">Caissiers avec accès limités</p>
                </div>
              </div>
              <Button onClick={() => setStep('first-product')} className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2">
                Commencer la configuration <ArrowRight className="h-4 w-4" />
              </Button>
              <button onClick={handleSkipOrComplete} className="text-sm text-slate-500 hover:text-slate-600 underline">
                Passer et aller au tableau de bord
              </button>
            </div>
          )}

          {/* ── FIRST PRODUCT ── */}
          {step === 'first-product' && (
            <div className="space-y-5">
              <div className="text-center">
                <div className="h-12 w-12 rounded-xl bg-indigo-100 flex items-center justify-center mx-auto mb-3">
                  <Package className="h-6 w-6 text-indigo-600" />
                </div>
                <h2 className="text-lg font-bold text-slate-800">Ajoutez votre premier produit</h2>
                <p className="text-sm text-slate-500 mt-1">Vous pourrez en ajouter autant que vous voulez ensuite</p>
              </div>

              <form onSubmit={handleAddProduct} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-slate-700">Nom du produit *</label>
                  <Input value={productName} onChange={(e) => setProductName(e.target.value)}
                    placeholder="Ex: Samsung Galaxy A15" autoFocus />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Prix de vente (F) *</label>
                    <Input type="number" value={productPrice} onChange={(e) => setProductPrice(e.target.value)}
                      placeholder="0" min="0" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-slate-700">Stock initial</label>
                    <Input type="number" value={productStock} onChange={(e) => setProductStock(e.target.value)}
                      placeholder="0" min="0" />
                  </div>
                </div>
                {error && <p className="text-red-600 text-sm">{error}</p>}
                <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2">
                  {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Ajout...</> : <>Ajouter ce produit <ArrowRight className="h-4 w-4" /></>}
                </Button>
              </form>
              <button onClick={() => setStep('invite')} className="w-full text-sm text-slate-500 hover:text-slate-600 underline">
                Passer cette étape
              </button>
            </div>
          )}

          {/* ── INVITE ── */}
          {step === 'invite' && (
            <div className="text-center space-y-5">
              <div className="h-12 w-12 rounded-xl bg-emerald-100 flex items-center justify-center mx-auto">
                <Users className="h-6 w-6 text-emerald-700" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-800">Invitez votre équipe</h2>
                <p className="text-sm text-slate-500 mt-1">
                  Vous pouvez créer des comptes employés depuis{' '}
                  <strong>Équipe → Ajouter un employé</strong> à tout moment.
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-4 text-left space-y-2">
                <p className="text-sm font-medium text-slate-700">Les employés peuvent :</p>
                <ul className="text-xs text-slate-500 space-y-1">
                  <li>✓ Enregistrer des ventes (caisse)</li>
                  <li>✓ Voir l&apos;inventaire</li>
                  <li>✓ Faire un inventaire physique</li>
                  <li>✗ Modifier les produits, rapports, équipe</li>
                </ul>
              </div>
              <Button onClick={() => setStep('done')} className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2">
                Continuer <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* ── DONE ── */}
          {step === 'done' && (
            <div className="text-center space-y-5">
              <div className="h-16 w-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
                <CheckCircle className="h-9 w-9 text-emerald-700" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-800">Tout est prêt !</h2>
                <p className="text-sm text-slate-500 mt-2">
                  Votre {domain === 'restaurant' ? 'établissement' : 'boutique'} <strong>{org?.name}</strong> est configuré.
                  Commencez à enregistrer vos ventes.
                </p>
              </div>
              <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-4 text-left">
                <p className="text-xs font-semibold text-indigo-700 mb-2">Plan gratuit inclut :</p>
                <ul className="text-xs text-slate-600 space-y-1">
                  <li>✓ 30 produits</li>
                  <li>✓ 1 employé</li>
                  <li>✓ Historique 30 jours</li>
                  <li>✓ Caisse, inventaire, scanner</li>
                </ul>
              </div>
              <Button
                onClick={handleSkipOrComplete}
                disabled={loading}
                className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2 font-semibold"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Accéder à mon tableau de bord'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
