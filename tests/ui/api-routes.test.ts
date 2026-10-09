/**
 * Tests des routes API — le trou de couverture le plus large du dépôt (T-1).
 *
 * Les handlers ne sont exercés qu'ici : le harnais SQL vérifie les fonctions,
 * mais pas le HTTP — codes de statut, validation, fail-closed, mapping
 * d'erreurs. Aucun appel réseau : `@supabase/supabase-js` est mocké et
 * `createClient` renvoie un faux client configurable.
 *
 * Ce qu'on protège en priorité : les chemins qui décident d'un accès
 * (401/403), d'une écriture (webhook, inscription) ou d'un refus fail-closed
 * (callback de paiement).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// `vi.hoisted` : le détenteur est défini avant les imports de modules, donc
// avant que la fabrique du mock ne l'utilise. `h.client` est réaffecté par test.
const h = vi.hoisted(() => ({
  client: null as unknown,
  createClient: vi.fn(() => h.client),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: h.createClient,
}));

// ── Faux client Supabase ────────────────────────────────────
// Builder thenable : chaque maillon (select/eq/…) renvoie le builder, et
// `maybeSingle`/`single`/`await` renvoient le résultat configuré.
type Rep = { data: unknown; error: { message: string; code?: string } | null };

function builder(result: Rep): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'order', 'limit', 'gte', 'lte', 'range']) {
    b[m] = () => b;
  }
  b.maybeSingle = () => Promise.resolve(result);
  b.single = () => Promise.resolve(result);
  // Supabase renvoie des thenables : `await client.from(...).insert(...)` doit
  // résoudre sans terminal explicite.
  b.then = (resolve: (v: Rep) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

interface FakeConfig {
  from?: Record<string, Rep>;
  rpc?: Record<string, Rep>;
  createUser?: () => { data: { user: { id: string } } | null; error: { message: string } | null };
  deleteUser?: () => Rep;
  listUsers?: () => { data: { users: Array<{ id: string; email?: string }> }; error: null };
  getUser?: () => { data: { user: { id: string; email?: string } | null }; error: { message: string } | null };
  signInWithPassword?: () => { data: { session: { access_token: string; refresh_token: string } | null }; error: { message: string } | null };
}

function fakeClient(cfg: FakeConfig = {}) {
  return {
    from: (table: string) => builder(cfg.from?.[table] ?? { data: null, error: null }),
    rpc: (fn: string) => Promise.resolve(cfg.rpc?.[fn] ?? { data: null, error: null }),
    auth: {
      admin: {
        createUser: () => Promise.resolve(cfg.createUser?.() ?? { data: { user: { id: 'user-1' } }, error: null }),
        deleteUser: () => Promise.resolve(cfg.deleteUser?.() ?? { data: {}, error: null }),
        listUsers: () => Promise.resolve(cfg.listUsers?.() ?? { data: { users: [] }, error: null }),
      },
      getUser: () => Promise.resolve(cfg.getUser?.() ?? { data: { user: { id: 'user-1', email: 'a@b.com' } }, error: null }),
      signInWithPassword: () => Promise.resolve(cfg.signInWithPassword?.() ?? { data: { session: { access_token: 'at', refresh_token: 'rt' } }, error: null }),
    },
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function get(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'), { method: 'GET', headers });
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  h.client = fakeClient();
  h.createClient.mockClear();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.PAYMENTS_PROVIDER;
  delete process.env.PAYMENTS_SANDBOX;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ─────────────────────────────────────────────────────────────
describe('GET /api/mecef/status', () => {
  it('sans session → 401 (le verrou reste fermé)', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { GET } = await import('@/app/api/mecef/status/route');
    const res = await GET(get('/api/mecef/status'));
    expect(res.status).toBe(401);
  });

  it('avec session → 200 { branche: false } (DGI non branchée)', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: { id: 'u1' } }, error: null }) });
    const { GET } = await import('@/app/api/mecef/status/route');
    const res = await GET(get('/api/mecef/status', { authorization: 'Bearer x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branche: false });
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/register', () => {
  it('corps invalide → 400', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    const { POST } = await import('@/app/api/register/route');
    const res = await POST(post('/api/register', { email: 'pas-un-email' }));
    expect(res.status).toBe(400);
  });

  it('sans clé service role → 503', async () => {
    const { POST } = await import('@/app/api/register/route');
    const res = await POST(post('/api/register', { email: 'a@b.com', password: 'secret1', businessName: 'Boutique' }));
    expect(res.status).toBe(503);
  });

  it('email déjà utilisé → 400', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({ createUser: () => ({ data: null, error: { message: 'User already registered' } }) });
    const { POST } = await import('@/app/api/register/route');
    const res = await POST(post('/api/register', { email: 'a@b.com', password: 'secret1', businessName: 'Boutique' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/déjà/i);
  });

  it('inscription réussie → 200 avec les jetons', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      createUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      from: { organizations: { data: null, error: null } },
    });
    const { POST } = await import('@/app/api/register/route');
    const res = await POST(post('/api/register', { email: 'A@B.com', password: 'secret1', businessName: 'Boutique' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: 'at', refresh_token: 'rt' });
  });

  it('la clé service role ne fuit jamais dans une réponse d’erreur', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      createUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      from: { organizations: { data: null, error: { message: 'Bearer srk eyJfuite' } } },
    });
    const { POST } = await import('@/app/api/register/route');
    const res = await POST(post('/api/register', { email: 'a@b.com', password: 'secret1', businessName: 'Boutique' }));
    const texte = await res.text();
    expect(texte).not.toContain('srk');
    expect(texte).not.toContain('eyJfuite');
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/invitations/accept', () => {
  const token = 'a'.repeat(32);

  it('corps invalide → 400', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token: 'court', name: '', password: 'x' }));
    expect(res.status).toBe(400);
  });

  it('sans clé service role → 503', async () => {
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(503);
  });

  it('jeton inconnu → 404', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({ from: { employee_invitations: { data: null, error: null } } });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(404);
  });

  it('jeton déjà utilisé → 410', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(410);
  });

  it('jeton expiré → 410', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2000-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(410);
  });

  it('parcours nominal → 200', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
      createUser: () => ({ data: { user: { id: 'membre-1' } }, error: null }),
      rpc: { redeem_invitation: { data: [{ member_id: 'membre-1' }], error: null } },
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe('m@b.c');
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/payments/callback/[provider] — fail-closed', () => {
  it('passerelle inconnue → 404', async () => {
    const { POST } = await import('@/app/api/payments/callback/[provider]/route');
    const res = await POST(post('/api/payments/callback/inconnu', { reference: 'x'.repeat(36) }), {
      params: Promise.resolve({ provider: 'inconnu' }),
    });
    expect(res.status).toBe(404);
  });

  it('bac à sable désactivé (PAYMENTS_SANDBOX absent) → 400, rien activé', async () => {
    const { POST } = await import('@/app/api/payments/callback/[provider]/route');
    const res = await POST(post('/api/payments/callback/sandbox', { reference: 'a'.repeat(36) }), {
      params: Promise.resolve({ provider: 'sandbox' }),
    });
    expect(res.status).toBe(400);
  });

  it('webhook d’une autre passerelle que celle configurée → 404', async () => {
    process.env.PAYMENTS_PROVIDER = 'fedapay';
    const { POST } = await import('@/app/api/payments/callback/[provider]/route');
    const res = await POST(post('/api/payments/callback/sandbox', { reference: 'a'.repeat(36) }), {
      params: Promise.resolve({ provider: 'sandbox' }),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────
describe('PATCH /api/employees/[id]', () => {
  const ctx = { params: Promise.resolve({ id: 'membre-1' }) };

  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { PATCH } = await import('@/app/api/employees/[id]/route');
    const res = await PATCH(post('/api/employees/membre-1', { role: 'manager' }), ctx);
    expect(res.status).toBe(401);
  });

  it('rôle invalide → 400', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: { id: 'u1' } }, error: null }) });
    const { PATCH } = await import('@/app/api/employees/[id]/route');
    const res = await PATCH(
      post('/api/employees/membre-1', { role: 'super-admin' }, { authorization: 'Bearer jeton' }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
