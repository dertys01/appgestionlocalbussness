'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { modeOuverture } from '@/lib/pwa/installation';
import { planEffectif } from '@/lib/utils/plans';
import { ecrireBoutique, ecrireMembre, lireBoutique, lireMembre } from '@/lib/offline/catalogue';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Organization, Plan } from '@/types';

interface SupabaseContextType {
  supabase: SupabaseClient;
  user: User | null;
  loading: boolean;
  ownerId: string | null;
  isEmployee: boolean;
  /** Vrai si l'utilisateur peut écrire dans le catalogue (RLS products_*) */
  canManageProducts: boolean;
  actorName: string | null;
  org: Organization | null;
  plan: Plan;
  /**
   * Échec de LECTURE de l'organisation (réseau, RLS, projet en pause).
   *
   * Différent de `org === null`, qui veut dire « cette boutique n'existe pas ».
   * Les confondre affichait « Configuration requise » à un utilisateur dont la
   * boutique existe pourtant, et l'invitait à la recréer — INSERT sur une clé
   * primaire déjà prise.
   */
  orgError: string | null;
  refreshOrg: () => Promise<void>;
}

const SupabaseContext = createContext<SupabaseContextType | null>(null);

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [isEmployee, setIsEmployee] = useState(false);
  // Miroir de la policy RLS can_manage_products() : un employé peut lire le
  // catalogue et encaisser, pas l'écrire. Sans ce garde-fou l'UI proposerait
  // des actions que la base refuse (cf. supabase/migration_roles.sql).
  const [canManageProducts, setCanManageProducts] = useState(false);
  const [actorName, setActorName] = useState<string | null>(null);
  const [org, setOrg] = useState<Organization | null>(null);
  const [plan, setPlan] = useState<Plan>('free');
  const [orgError, setOrgError] = useState<string | null>(null);
  // Le journal de connexion ne doit s'écrire qu'UNE fois par montage. En
  // StrictMode (dev), l'effet de montage s'exécute deux fois : sans ce garde,
  // chaque connexion en développement produisait deux lignes « s'est
  // connecté(e) ».
  const loginJournalise = useRef(false);

  // useCallback : sans lui, loadOrg et refreshOrg changent de référence à chaque
  // render — et comme refreshOrg entre dans la valeur du contexte, la valeur
  // changeait aussi, re-rendant les 20 consommateurs (dont le POS) pour rien.
  const loadOrg = useCallback(async (ownerIdVal: string): Promise<Organization | null> => {
    // Applique une organisation (serveur OU cache) et calcule le plan effectif.
    const appliquer = (o: Organization) => {
      setOrg(o);
      // Plan EFFECTIF : un essai Starter actif rend le plan utile 'starter',
      // alors que organizations.plan dit encore 'free' (le brut reste
      // l'affaire du webhook Stripe). Miroir de current_org_plan() en base.
      setPlan(planEffectif(o.plan, o.trial_ends_at, o.plan_valid_until));
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('organizations')
        .select('*')
        .eq('id', ownerIdVal)
        .maybeSingle();

      // supabase-js ne LÈVE pas : il renvoie { error }. On le transforme en
      // exception pour un seul chemin d'erreur (réseau vs autre).
      if (error) throw new Error(error.message ?? 'Lecture de la boutique impossible.');
      setOrgError(null);
      if (data) {
        appliquer(data as Organization);
        void ecrireBoutique(ownerIdVal, data);
        return data as Organization;
      }
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Lecture de la boutique impossible.';
      // Réseau coupé : on sert la boutique en cache plutôt que de bloquer
      // l'application sur « Lecture impossible ». Sans elle, `home-client`
      // n'affiche JAMAIS la caisse (écran OrgLoadFailed) — et tout le mode
      // hors-ligne (file de ventes, cache catalogue) devenait inutile.
      if (/failed to fetch|networkerror|fetch failed|load failed/i.test(message)) {
        const cache = await lireBoutique<Organization>(ownerIdVal);
        if (cache) {
          appliquer(cache);
          setOrgError(null);
          return cache;
        }
      }
      setOrgError(message);
      return null;
    }
  }, [supabase]);

  const refreshOrg = useCallback(async () => {
    if (ownerId) await loadOrg(ownerId);
  }, [ownerId, loadOrg]);

  const resolveMembership = async (u: User) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: errMembre } = await (supabase as any)
        .from('business_members')
        .select('owner_id, member_name, role')
        .eq('member_id', u.id)
        .maybeSingle() as { data: { owner_id: string; member_name: string; role: string } | null; error: { message: string } | null };

      // Réseau coupé : on relit le rattachement en cache plutôt que de prendre
      // un employé pour un patron — il chercherait alors un catalogue sous son
      // propre identifiant et ne trouverait rien.
      if (!data && errMembre && /failed to fetch|networkerror|fetch failed|load failed/i.test(errMembre.message)) {
        const cache = await lireMembre<{ ownerId: string; isEmployee: boolean; actorName: string; canManageProducts: boolean }>(u.id);
        if (cache) {
          setOwnerId(cache.ownerId);
          setIsEmployee(cache.isEmployee);
          setActorName(cache.actorName);
          setCanManageProducts(cache.canManageProducts);
          await loadOrg(cache.ownerId);
          return;
        }
      }

      let resolvedOwnerId: string;
      let resolvedName: string;

      if (data) {
        resolvedOwnerId = data.owner_id;
        resolvedName = data.member_name;
        setOwnerId(resolvedOwnerId);
        setIsEmployee(true);
        setActorName(resolvedName);
        // Rôle 'owner' ou 'manager' requis pour gérer le catalogue ; sinon
        // simple caissier.
        setCanManageProducts(['owner', 'manager'].includes(data.role ?? 'employee'));
        // Cache du rattachement : permet de retrouver le patron hors-ligne.
        void ecrireMembre(u.id, {
          ownerId: resolvedOwnerId,
          isEmployee: true,
          actorName: resolvedName,
          canManageProducts: ['owner', 'manager'].includes(data.role ?? 'employee'),
        });
      } else {
        resolvedOwnerId = u.id;
        resolvedName = u.email ?? u.id;
        setOwnerId(resolvedOwnerId);
        setIsEmployee(false);
        setCanManageProducts(true);
        setActorName(resolvedName);
        // Cache du rattachement : « patron » se retrouve hors-ligne.
        void ecrireMembre(u.id, { ownerId: resolvedOwnerId, isEmployee: false, actorName: resolvedName, canManageProducts: true });
      }

      // Journal d'audit : non bloquant, et UNE seule fois par montage. Une
      // écriture qui échoue ne doit pas remplacer l'écran par une erreur, et
      // StrictMode (dev) ne doit pas produire deux lignes « s'est connecté(e) ».
      if (!loginJournalise.current) {
        loginJournalise.current = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from('activity_logs').insert({
          business_owner_id: resolvedOwnerId,
          actor_id: u.id,
          actor_email: u.email ?? '',
          actor_name: resolvedName,
          action: 'login',
          description: data ? `${resolvedName} s'est connecté(e)` : 'Connexion patron',
        }).then(() => {}, () => {});
      }

      const ligne = await loadOrg(resolvedOwnerId);

      // Relevé d'ouverture (P2/P3) : la base dit comment ce patron ouvre
      // son application — icône installée ou onglet du navigateur — pour
      // que le relevé du parcours (npm run stats:activation) lise le mode
      // à côté des semaines 2 et 4. Seul le patron signe : un caissier en
      // navigateur n'infirme rien, et la RLS « Patron modifie sa propre
      // org » lui refuse d'ailleurs l'écriture. Une écriture seulement si
      // le mode a changé — pas une par visite. Non bloquant, au même titre
      // que le journal d'audit ci-dessus : un échec de mesure ne doit pas
      // coûter une connexion.
      if (!data && ligne) {
        const mode = modeOuverture();
        if (ligne.display_mode !== mode) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).from('organizations')
            .update({ display_mode: mode, display_mode_at: new Date().toISOString() })
            .eq('id', resolvedOwnerId)
            .then(() => {}, () => {});
        }
      }
    } catch (e) {
      // Ne jamais bloquer l'app — mais ne pas faire comme si de rien n'était :
      // sans ce message, canManageProducts resterait à false et l'UI passerait
      // en lecture seule sans explication.
      setOrgError(e instanceof Error ? e.message : 'Connexion à la boutique impossible.');
    }
  };

  useEffect(() => {
    // Une session locale peut être invalide (projet Supabase mis en pause puis
    // repris, jeton expiré, refresh token révoqué) : getUser() rejette alors.
    // Sans ce catch, setLoading(false) n'était jamais appelé et l'application
    // restait bloquée sur le spinner au lieu de proposer la reconnexion.
    let cancelled = false;

    const clearSession = () => {
      setUser(null);
      setOwnerId(null);
      setIsEmployee(false);
      setCanManageProducts(false);
      setActorName(null);
      setOrg(null);
      setPlan('free');
      setOrgError(null);
    };

    supabase.auth
      .getUser()
      .then(async ({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // Réseau coupé : on NE déconnecte PAS. La session locale reste
          // valide, la RLS protège les données, et getUser() re-vérifiera au
          // retour du réseau. Déconnecter hors-ligne rendait la caisse
          // inutilisable alors même que le mode hors-ligne existe.
          const reseau =
            (error as { status?: number }).status === 0 ||
            (error as { name?: string }).name === 'AuthRetryableFetchError' ||
            /fetch|network|load failed/i.test(error.message ?? '');
          if (reseau) {
            const { data: sess } = await supabase.auth.getSession();
            if (cancelled) return;
            const u = sess.session?.user ?? null;
            setUser(u);
            if (u) resolveMembership(u).finally(() => { if (!cancelled) setLoading(false); });
            else setLoading(false);
            return;
          }
          // Le refresh token stocké ne vaut plus rien : on le purge pour éviter
          // de boucler sur la même erreur à chaque rechargement.
          console.warn('[auth] session invalide, déconnexion', error.message);
          supabase.auth.signOut().catch(() => {});
          clearSession();
          setLoading(false);
          return;
        }
        const u = data.user ?? null;
        setUser(u);
        if (u) resolveMembership(u).finally(() => { if (!cancelled) setLoading(false); });
        else setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[auth] échec getUser', e);
        clearSession();
        setLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // SIGNED_OUT est émis aussi quand un refresh échoue : c'est le chemin
      // de sortie propre vers l'écran de connexion.
      if (event === 'SIGNED_OUT') {
        clearSession();
        setLoading(false);
        return;
      }
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;

      const u = session?.user ?? null;
      setUser(u);
      if (u && event === 'SIGNED_IN') {
        setLoading(true);
        resolveMembership(u).finally(() => { if (!cancelled) setLoading(false); });
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  // useMemo : l'objet littéral inline qui était là était recréé à chaque render
  // du Provider. Comme le contexte, ça re-rendrait tout le monde pour rien.
  const value = useMemo(
    () => ({
      supabase, user, loading, ownerId, isEmployee, canManageProducts,
      actorName, org, plan, orgError, refreshOrg,
    }),
    [supabase, user, loading, ownerId, isEmployee, canManageProducts,
     actorName, org, plan, orgError, refreshOrg]
  );

  return (
    <SupabaseContext.Provider value={value}>
      {children}
    </SupabaseContext.Provider>
  );
}

export function useSupabase() {
  const ctx = useContext(SupabaseContext);
  if (!ctx) throw new Error('useSupabase doit être utilisé dans <SupabaseProvider>');
  return ctx;
}
