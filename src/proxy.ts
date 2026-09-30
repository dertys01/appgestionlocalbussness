import { NextRequest, NextResponse } from 'next/server';

/**
 * Rate limiting en mémoire.
 *
 * ⚠️  CE LIMITEUR N'EST PAS EFFICACE EN PRODUCTION SERVEURLESS.
 * Le store vit dans le process : sur Vercel chaque instance est isolée et le
 * module est ré-évalué à froid, donc la Map repart vide à chaque invocation et
 * le seuil n'est jamais atteint. Il protège `next dev` et les déploiements
 * Node à instance unique ; ailleurs il ne fait rien.
 *
 * Vrai rempart : @upstash/ratelimit + Redis, ou compter via PostgREST dans une
 * table `rate_limits` (déjà le cas pour /api/register, qui s'appuie sur la
 * service role). Voir README pour le détail.
 */
const store = new Map<string, { count: number; reset: number }>();

function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.reset) {
    store.set(key, { count: 1, reset: now + windowMs });
    return true; // autorisé
  }

  if (entry.count >= max) return false; // bloqué

  entry.count++;
  return true;
}

// Nettoyage périodique pour éviter les fuites mémoire.
// `unref()` : sans cela le setInterval maintiendrait le process en vie.
const cleanup = setInterval(() => {
  const now = Date.now();
  store.forEach((v, k) => { if (now > v.reset) store.delete(k); });
}, 60_000);
if (typeof cleanup === 'object' && cleanup !== null && 'unref' in cleanup) {
  (cleanup as { unref: () => void }).unref();
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Routes protégées par rate limiting
  const sensitiveRoutes = [
    '/api/employees',
    '/api/stripe/checkout',
    '/api/stripe/portal',
  ];

  const isSensitive = sensitiveRoutes.some((r) => pathname.startsWith(r));
  if (!isSensitive) return NextResponse.next();

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown';
  const key = `${ip}:${pathname}`;

  const allowed = rateLimit(key, 10, 60_000); // 10 requêtes par minute

  if (!allowed) {
    return NextResponse.json(
      { error: 'Trop de requêtes, réessayez dans un moment.' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
