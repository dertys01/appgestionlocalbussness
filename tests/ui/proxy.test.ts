import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Rate limiting des routes sensibles (src/proxy.ts).
 *
 * Jusqu'ici seuls les helpers purs (`ruleFor`, `isOverLimit`) et la fonction
 * SQL étaient testés : le chemin d'ENFORCEMENT — lecture d'IP, normalisation
 * du chemin, appel réseau, fail-open — ne l'était pas. C'est ce que ce fichier
 * couvre, avec `fetch` remplacé par un double.
 */
vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import { proxy } from '@/proxy';

/** Valeur renvoyée par bump_rate_limit, par test. */
let depasse = false;

function req(method: string, path: string, ip = '1.2.3.4'): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost'), {
    method,
    headers: { 'x-forwarded-for': ip },
  });
}

function rpcAppele(nom: string): Record<string, unknown>[] {
  const appels = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return appels
    .filter(([url]) => String(url).includes(`/rpc/${nom}`))
    .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  depasse = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const fn = String(url).split('/rpc/')[1];
    const data = fn === 'bump_rate_limit' ? depasse : 0;
    return { ok: true, json: async () => data } as unknown as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('proxy — rate limiting', () => {
  it('laisse passer une lecture (GET), sans compter', async () => {
    const res = await proxy(req('GET', '/api/register'));
    expect(res.status).toBe(200);
    expect(rpcAppele('bump_rate_limit')).toHaveLength(0);
  });

  it('laisse passer une écriture sous le seuil', async () => {
    depasse = false;
    const res = await proxy(req('POST', '/api/register'));
    expect(res.status).toBe(200);
    expect(rpcAppele('bump_rate_limit')).toHaveLength(1);
  });

  it('bloque au-delà du seuil (429 + Retry-After)', async () => {
    depasse = true;
    const res = await proxy(req('POST', '/api/register'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('fail-open : une panne du limiteur laisse passer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    const res = await proxy(req('POST', '/api/register'));
    expect(res.status).toBe(200);
  });

  it('normalise le chemin : « /API/register/ » et « /api/register » partagent le compteur', async () => {
    await proxy(req('POST', '/API/register/'));
    await proxy(req('POST', '/api/register'));
    const cles = rpcAppele('bump_rate_limit').map((a) => a.p_key);
    expect(cles).toHaveLength(2);
    expect(cles[0]).toBe(cles[1]);
  });

  it('ne touche pas une route non sensible', async () => {
    const res = await proxy(req('POST', '/api/health'));
    expect(res.status).toBe(200);
    expect(rpcAppele('bump_rate_limit')).toHaveLength(0);
  });
});
