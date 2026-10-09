import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { isOverLimit, ruleFor, type RateLimitRule } from './lib/rate-limit';

/**
 * Rate limiting des routes sensibles.
 *
 * Le compteur vivait dans une Map du module. Sur Vercel chaque instance est
 * isolée et le module est ré-évalué à froid : la Map repartait vide, le seuil
 * n'était jamais atteint, et la limite ne bloquait rien en production — le
 * commentaire qui précédait l'admettait ouvertement.
 *
 * Le compteur est désormais dans la table `rate_limits`, appelée par
 * bump_rate_limit() (SECURITY DEFINER, verrou de ligne). C'est
 * l'infrastructure déjà utilisée par /api/register : partagée par toutes les
 * instances, persistante d'un cold start à l'autre, et qui sérialise deux
 * écritures simultanées au lieu de les laisser se croiser.
 *
 * Deux choix, détaillés dans src/lib/rate-limit.ts :
 *   • seules les écritures sont comptées — une lecture n'a aucun effet de
 *     bord et limiter les GET bloquait le rafraîchisseur de la console ;
 *   • une panne de la base laisse passer la requête (fail-open) : un souci
 *     PostgREST ne doit pas rendre l'inscription inaccessible.
 */

const SENSITIVE_ROUTES = [
  '/api/employees',
  // Invitations et acceptation : la première crée un jeton d'accès, la seconde
  // crée un compte. Les deux doivent être encadrées comme la création d'un
  // compte patron.
  '/api/invitations',
  '/api/register',
  '/api/stripe/checkout',
  '/api/stripe/portal',
];

/**
 * Purge des compteurs expirés.
 *
 * bump_rate_limit() réutilise une ligne à chaque appel, mais une clé d'IP qui
 * ne revient plus reste dans la table pour toujours : purge_rate_limits()
 * existait sans jamais être appelé. Sans ce garde-fou, le compteur multiplié
 * par cinq chemins aurait fait grandir rate_limits sans limite.
 *
 * Appelée en await : un fetch lancé sans l'être peut être coupé par le retour
 * de la réponse, et la purge n'aurait jamais lieu. Coût : un aller-retour de
 * plus, une fois toutes les dix minutes.
 */
const PURGE_INTERVAL_MS = 10 * 60_000;
let nextPurgeAt = 0;
let warnedMissingEnv = false;

/**
 * Variables lues par accès dynamique (`process.env[name]`), que Next.js ne
 * remplace pas au build : les valeurs sont résolues par le process au
 * démarrage, et le bundle ne contient que le nom de la variable.
 */
function env(name: string): string {
  return process.env[name] ?? '';
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const url = env('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');

  if (!url || !serviceKey) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.warn('[proxy] rate limit désactivé : URL ou clé service absente');
      Sentry.captureMessage('[proxy] rate limit désactivé : variables manquantes', 'warning');
    }
    return undefined;
  }

  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(args),
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`${fn} a répondu HTTP ${res.status}`);
  return res.json();
}

async function isAllowed(key: string, rule: RateLimitRule): Promise<boolean> {
  if (purgeIsDue()) {
    // Son échec n'a aucune incidence sur la requête en cours : d'où le catch.
    await rpc('purge_rate_limits', {}).catch(() => {});
  }

  try {
    const over = await rpc('bump_rate_limit', {
      p_key: key,
      p_max: rule.max,
      p_window_seconds: rule.windowSeconds,
    });
    return !isOverLimit(over);
  } catch (err) {
    // Fail-open, à l'identique de /api/register : on journalise et on laisse
    // passer. Un compteur qui bloque l'inscription vaut pire qu'absent.
    // Sentry remonte l'incident : le rate limit peut ainsi être désactivé
    // pendant des heures sans que personne ne s'en aperçoive autrement.
    console.error('[proxy] rate limit indisponible', err instanceof Error ? err.message : err);
    Sentry.captureException(err);
    return true;
  }
}

function purgeIsDue(): boolean {
  if (Date.now() < nextPurgeAt) return false;
  nextPurgeAt = Date.now() + PURGE_INTERVAL_MS;
  return true;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Chemin normalisé UNE fois : slash final retiré, casse unifiée. Il sert à
  // la fois à reconnaître une route sensible et à construire la clé du
  // compteur — sinon `/API/register` passait le filtre sensible (casse
  // différente) mais `/api/register/` et `/api/register` créaient deux
  // compteurs. Les deux moitiés devaient penser pareil.
  const chemin = pathname.replace(/\/+$/, '').toLowerCase();

  const isSensitive = SENSITIVE_ROUTES.some((r) => chemin.startsWith(r));
  if (!isSensitive) return NextResponse.next();

  const rule = ruleFor(req.method);
  // Lecture : rien à compter, et surtout aucun aller-retour en base.
  if (!rule) return NextResponse.next();

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const allowed = await isAllowed(`proxy:${ip}:${chemin}`, rule);

  if (!allowed) {
    return NextResponse.json(
      { error: 'Trop de requêtes, réessayez dans un moment.' },
      { status: 429, headers: { 'Retry-After': String(rule.windowSeconds) } }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
