import { NextRequest, NextResponse } from 'next/server';

// Simple in-memory rate limiter (10 req/min par IP par route)
// Pour production haute-charge : remplacer par @upstash/ratelimit + Redis
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

// Nettoyage périodique pour éviter les fuites mémoire
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    store.forEach((v, k) => { if (now > v.reset) store.delete(k); });
  }, 60_000);
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
