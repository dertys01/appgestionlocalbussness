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

// Stripe : la route webhook construit l'événement à partir de la signature. On
// remplace la classe par un double qui rend l'événement fourni par le test.
const stripeMock = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrieve: vi.fn(),
  customersCreate: vi.fn(),
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: class {
    webhooks = { constructEvent: stripeMock.constructEvent };
    subscriptions = { retrieve: stripeMock.retrieve };
    customers = { create: stripeMock.customersCreate };
    checkout = { sessions: { create: stripeMock.checkoutCreate } };
    billingPortal = { sessions: { create: stripeMock.portalCreate } };
  },
}));

// ── Faux client Supabase ────────────────────────────────────
// Builder thenable : chaque maillon (select/eq/…) renvoie le builder, et
// `maybeSingle`/`single`/`await` renvoient le résultat configuré.
type Rep = { data: unknown; error: { message: string; code?: string } | null; count?: number };

function builder(result: Rep): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'is', 'order', 'limit', 'gte', 'lte', 'range']) {
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

  it('rate limit dédié dépassé → 429 (avec Retry-After)', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({ rpc: { bump_rate_limit: { data: true, error: null } } });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('compte déjà existant retrouvé par la liste → 200 (mot de passe jamais réécrit)', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
      createUser: () => ({ data: null, error: { message: 'User already registered' } }),
      listUsers: () => ({ data: { users: [{ id: 'existant-1', email: 'M@B.C' }] }, error: null }),
      rpc: { redeem_invitation: { data: [{ member_id: 'existant-1' }], error: null } },
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(200);
  });

  it('compte déjà existant introuvable dans la liste → 409', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
      createUser: () => ({ data: null, error: { message: 'User already registered' } }),
      listUsers: () => ({ data: { users: [] }, error: null }),
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(409);
  });

  it('échec de création non lié à un doublon → 503', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
      createUser: () => ({ data: null, error: { message: 'Database error checking email' } }),
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(503);
  });

  it('redeem : lien déjà utilisé → 410 (compte créé nettoyé)', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
      createUser: () => ({ data: { user: { id: 'membre-1' } }, error: null }),
      rpc: { redeem_invitation: { data: null, error: { message: "L'invitation a déjà été utilisée" } } },
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(410);
  });

  it('redeem : le compte possède déjà sa propre boutique → 409', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    h.client = fakeClient({
      from: {
        employee_invitations: {
          data: { email: 'm@b.c', accepted_at: null, expires_at: '2099-01-01T00:00:00Z', owner_id: 'o1' },
          error: null,
        },
      },
      createUser: () => ({ data: { user: { id: 'membre-1' } }, error: null }),
      rpc: { redeem_invitation: { data: null, error: { message: 'Ce compte possède déjà sa propre boutique' } } },
    });
    const { POST } = await import('@/app/api/invitations/accept/route');
    const res = await POST(post('/api/invitations/accept', { token, name: 'Marie', password: 'secret1' }));
    expect(res.status).toBe(409);
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
  const patron = () => fakeClient({
    getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
    rpc: { get_business_owner_id: { data: 'u1', error: null } },
  });

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

  it('appelant qui n’est pas le patron → 403', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: { get_business_owner_id: { data: 'owner-9', error: null } },
    });
    const { PATCH } = await import('@/app/api/employees/[id]/route');
    const res = await PATCH(post('/api/employees/membre-1', { role: 'manager' }, { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(403);
  });

  it('membre hors de l’équipe (P0002) → 404', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: {
        get_business_owner_id: { data: 'u1', error: null },
        business_members_set_role: { data: null, error: { message: 'introuvable', code: 'P0002' } },
      },
    });
    const { PATCH } = await import('@/app/api/employees/[id]/route');
    const res = await PATCH(post('/api/employees/membre-1', { role: 'manager' }, { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(404);
  });

  it('refus métier (22023) → 400 avec le message', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: {
        get_business_owner_id: { data: 'u1', error: null },
        business_members_set_role: { data: null, error: { message: 'Dernier manager', code: '22023' } },
      },
    });
    const { PATCH } = await import('@/app/api/employees/[id]/route');
    const res = await PATCH(post('/api/employees/membre-1', { role: 'employee' }, { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Dernier manager');
  });

  it('patron, rôle valide → 200', async () => {
    h.client = patron();
    const { PATCH } = await import('@/app/api/employees/[id]/route');
    const res = await PATCH(post('/api/employees/membre-1', { role: 'manager' }, { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('DELETE /api/employees/[id]', () => {
  const ctx = { params: Promise.resolve({ id: 'membre-1' }) };

  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { DELETE } = await import('@/app/api/employees/[id]/route');
    const res = await DELETE(get('/api/employees/membre-1'), ctx);
    expect(res.status).toBe(401);
  });

  it('appelant qui n’est pas le patron → 403', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: { get_business_owner_id: { data: 'owner-9', error: null } },
    });
    const { DELETE } = await import('@/app/api/employees/[id]/route');
    const res = await DELETE(get('/api/employees/membre-1', { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(403);
  });

  it('membre hors de l’équipe (P0002) → 404', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: {
        get_business_owner_id: { data: 'u1', error: null },
        business_members_remove: { data: null, error: { message: 'introuvable', code: 'P0002' } },
      },
    });
    const { DELETE } = await import('@/app/api/employees/[id]/route');
    const res = await DELETE(get('/api/employees/membre-1', { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(404);
  });

  it('patron → 200 (retrait du lien seulement)', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: { get_business_owner_id: { data: 'u1', error: null } },
    });
    const { DELETE } = await import('@/app/api/employees/[id]/route');
    const res = await DELETE(get('/api/employees/membre-1', { authorization: 'Bearer j' }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('/api/invitations', () => {
  const patron = (from: Record<string, Rep> = {}) => fakeClient({
    getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
    rpc: { get_business_owner_id: { data: 'u1', error: null } },
    from,
  });
  const org = (plan: string) => ({ organizations: { data: { plan, trial_ends_at: null, plan_valid_until: null }, error: null } });

  it('GET sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { GET } = await import('@/app/api/invitations/route');
    const res = await GET(get('/api/invitations'));
    expect(res.status).toBe(401);
  });

  it('GET patron → 200 avec ses invitations', async () => {
    h.client = patron({
      employee_invitations: { data: [{ id: 'i1', email: 'a@b.c', role: 'employee', created_at: '', expires_at: '' }], error: null },
    });
    const { GET } = await import('@/app/api/invitations/route');
    const res = await GET(get('/api/invitations', { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    expect((await res.json()).invitations[0].email).toBe('a@b.c');
  });

  it('POST email invalide → 400', async () => {
    h.client = patron();
    const { POST } = await import('@/app/api/invitations/route');
    const res = await POST(post('/api/invitations', { email: 'pas-un-email' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(400);
  });

  it('POST réutilise un lien en attente pour la même adresse', async () => {
    h.client = patron({
      employee_invitations: { data: { id: 'i1', email: 'a@b.c', token: 'hash', expires_at: '2099-01-01T00:00:00Z' }, error: null },
    });
    const { POST } = await import('@/app/api/invitations/route');
    const res = await POST(post('/api/invitations', { email: 'employe@boutique.com' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reused).toBe(true);
    expect(body.url).toContain('/invitation/');
  });

  it('POST refuse au-delà de 20 invitations en attente → 429', async () => {
    h.client = patron({ employee_invitations: { data: null, error: null, count: 20 } });
    const { POST } = await import('@/app/api/invitations/route');
    const res = await POST(post('/api/invitations', { email: 'nouveau@boutique.com' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(429);
  });

  it('POST refuse au-delà du quota du plan → 403', async () => {
    h.client = patron(org('free')); // plan gratuit : 0 employé
    const { POST } = await import('@/app/api/invitations/route');
    const res = await POST(post('/api/invitations', { email: 'nouveau@boutique.com' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(403);
  });

  it('DELETE sans identifiant → 400', async () => {
    h.client = patron();
    const { DELETE } = await import('@/app/api/invitations/route');
    const res = await DELETE(get('/api/invitations', { authorization: 'Bearer j' }));
    expect(res.status).toBe(400);
  });

  it('DELETE patron → 200', async () => {
    h.client = patron();
    const { DELETE } = await import('@/app/api/invitations/route');
    const res = await DELETE(get('/api/invitations?id=i1', { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('signature invalide → 400, aucun traitement', async () => {
    stripeMock.constructEvent.mockImplementation(() => { throw new Error('bad signature'); });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt' }, { 'stripe-signature': 'faux' }));
    expect(res.status).toBe(400);
  });

  it('événement déjà pris en charge → duplicate (idempotence)', async () => {
    stripeMock.constructEvent.mockReturnValue({
      id: 'evt_1', type: 'customer.subscription.updated',
      data: { object: { metadata: { org_id: 'o1' } } },
    });
    h.client = fakeClient({ rpc: { claim_webhook_event: { data: false, error: null } } });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt_1' }, { 'stripe-signature': 'ok' }));
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(true);
  });

  it('checkout.session.completed actif → 200', async () => {
    stripeMock.constructEvent.mockReturnValue({
      id: 'evt_2', type: 'checkout.session.completed',
      data: { object: { metadata: { org_id: 'o1', plan: 'pro' }, subscription: 'sub_1', customer: 'cus_1' } },
    });
    stripeMock.retrieve.mockResolvedValue({
      id: 'sub_1', status: 'active',
      items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1893456000 }] },
    });
    h.client = fakeClient({ rpc: { claim_webhook_event: { data: true, error: null } } });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt_2' }, { 'stripe-signature': 'ok' }));
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
  });

  it('journalisation atomique indisponible : repli sur « déjà traité »', async () => {
    stripeMock.constructEvent.mockReturnValue({
      id: 'evt_3', type: 'customer.subscription.deleted',
      data: { object: { metadata: { org_id: 'o1' } } },
    });
    h.client = fakeClient({
      rpc: { claim_webhook_event: { data: null, error: { message: 'function claim_webhook_event does not exist' } } },
      from: { webhook_events: { data: { status: 'processed' }, error: null } },
    });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt_3' }, { 'stripe-signature': 'ok' }));
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(true);
  });

  it('annulation : customer.subscription.deleted → 200', async () => {
    stripeMock.constructEvent.mockReturnValue({
      id: 'evt_4', type: 'customer.subscription.deleted',
      data: { object: { metadata: { org_id: 'o1' } } },
    });
    h.client = fakeClient({ rpc: { claim_webhook_event: { data: true, error: null } } });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt_4' }, { 'stripe-signature': 'ok' }));
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
  });

  it('checkout sans abonnement : rien à activer, 200', async () => {
    stripeMock.constructEvent.mockReturnValue({
      id: 'evt_5', type: 'checkout.session.completed',
      data: { object: { metadata: { org_id: 'o1' }, subscription: null } },
    });
    h.client = fakeClient({ rpc: { claim_webhook_event: { data: true, error: null } } });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt_5' }, { 'stripe-signature': 'ok' }));
    expect(res.status).toBe(200);
  });

  it('échec d’écriture : 500 (un paiement ne reste pas en Free en silence)', async () => {
    stripeMock.constructEvent.mockReturnValue({
      id: 'evt_6', type: 'customer.subscription.deleted',
      data: { object: { metadata: { org_id: 'o1' } } },
    });
    h.client = fakeClient({
      rpc: { claim_webhook_event: { data: true, error: null } },
      from: { subscriptions: { data: null, error: { message: 'boom' } }, webhook_events: { data: null, error: null } },
    });
    const { POST } = await import('@/app/api/stripe/webhook/route');
    const res = await POST(post('/api/stripe/webhook', { id: 'evt_6' }, { 'stripe-signature': 'ok' }));
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/payments/order', () => {
  const patron = () => fakeClient({
    getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
    rpc: { get_business_owner_id: { data: 'u1', error: null } },
  });

  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { POST } = await import('@/app/api/payments/order/route');
    const res = await POST(post('/api/payments/order', { plan: 'pro', mois: 1 }));
    expect(res.status).toBe(401);
  });

  it('patron, demande invalide → 400', async () => {
    h.client = patron();
    const { POST } = await import('@/app/api/payments/order/route');
    const res = await POST(post('/api/payments/order', { plan: 'inconnu', mois: 2 }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(400);
  });

  it('bac à sable non activé → 503 (fail-closed)', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    delete process.env.PAYMENTS_SANDBOX;
    h.client = patron();
    const { POST } = await import('@/app/api/payments/order/route');
    const res = await POST(post('/api/payments/order', { plan: 'pro', mois: 1 }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────
describe('GET /api/payments/order', () => {
  const patron = (from: Record<string, Rep> = {}) => fakeClient({
    getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
    rpc: { get_business_owner_id: { data: 'u1', error: null } },
    from,
  });
  const ref = 'a'.repeat(36);

  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { GET } = await import('@/app/api/payments/order/route');
    const res = await GET(get(`/api/payments/order?ref=${ref}`));
    expect(res.status).toBe(401);
  });

  it('référence invalide → 400', async () => {
    h.client = patron();
    const { GET } = await import('@/app/api/payments/order/route');
    const res = await GET(get('/api/payments/order?ref=pas-une-ref', { authorization: 'Bearer j' }));
    expect(res.status).toBe(400);
  });

  it('commande introuvable → 404', async () => {
    h.client = patron({ payment_orders: { data: null, error: null } });
    const { GET } = await import('@/app/api/payments/order/route');
    const res = await GET(get(`/api/payments/order?ref=${ref}`, { authorization: 'Bearer j' }));
    expect(res.status).toBe(404);
  });

  it('patron → 200 avec l’état de la commande', async () => {
    h.client = patron({
      payment_orders: {
        data: { reference: ref, plan: 'pro', period_months: 3, amount: 20000, status: 'pending' },
        error: null,
      },
    });
    const { GET } = await import('@/app/api/payments/order/route');
    const res = await GET(get(`/api/payments/order?ref=${ref}`, { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/invitations', () => {
  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { POST } = await import('@/app/api/invitations/route');
    const res = await POST(post('/api/invitations', { email: 'a@b.com' }));
    expect(res.status).toBe(401);
  });

  it('patron, email invalide → 400', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: { get_business_owner_id: { data: 'u1', error: null } },
    });
    const { POST } = await import('@/app/api/invitations/route');
    const res = await POST(post('/api/invitations', { email: 'pas-un-email' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/stripe/checkout', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
  });

  const user = () => ({ data: { user: { id: 'u1', email: 'a@b.com' } }, error: null });

  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { POST } = await import('@/app/api/stripe/checkout/route');
    const res = await POST(post('/api/stripe/checkout', { plan: 'pro' }));
    expect(res.status).toBe(401);
  });

  it('plan invalide → 400', async () => {
    h.client = fakeClient({ getUser: user });
    const { POST } = await import('@/app/api/stripe/checkout/route');
    const res = await POST(post('/api/stripe/checkout', { plan: 'gratuit' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(400);
  });

  it('abonnement déjà actif → 409 (pas de second abonnement)', async () => {
    h.client = fakeClient({
      getUser: user,
      from: { subscriptions: { data: { status: 'active', stripe_customer_id: 'cus_1' }, error: null } },
    });
    const { POST } = await import('@/app/api/stripe/checkout/route');
    const res = await POST(post('/api/stripe/checkout', { plan: 'pro' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(409);
  });

  it('nouvel abonnement → 200 avec l’URL de session', async () => {
    stripeMock.customersCreate.mockResolvedValue({ id: 'cus_new' });
    stripeMock.checkoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });
    h.client = fakeClient({ getUser: user, from: { subscriptions: { data: null, error: null } } });
    const { POST } = await import('@/app/api/stripe/checkout/route');
    const res = await POST(post('/api/stripe/checkout', { plan: 'pro' }, { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://checkout.stripe.com/x');
  });
});

// ─────────────────────────────────────────────────────────────
describe('POST /api/stripe/portal', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  });

  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { POST } = await import('@/app/api/stripe/portal/route');
    const res = await POST(post('/api/stripe/portal', {}));
    expect(res.status).toBe(401);
  });

  it('aucun client Stripe → 404', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      from: { subscriptions: { data: null, error: null } },
    });
    const { POST } = await import('@/app/api/stripe/portal/route');
    const res = await POST(post('/api/stripe/portal', {}, { authorization: 'Bearer j' }));
    expect(res.status).toBe(404);
  });

  it('client existant → 200 avec l’URL du portail', async () => {
    stripeMock.portalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/y' });
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      from: { subscriptions: { data: { stripe_customer_id: 'cus_1' }, error: null } },
    });
    const { POST } = await import('@/app/api/stripe/portal/route');
    const res = await POST(post('/api/stripe/portal', {}, { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://billing.stripe.com/y');
  });
});

// ─────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  const ORIG = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIG.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ORIG.anon;
    vi.unstubAllGlobals();
  });

  it('configuration absente → 503', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).raison).toBe('configuration');
  });

  it('base joignable (200 sur une table) → 200 { ok: true }', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sb_publishable_x';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true });
  });

  /**
   * Le bug : depuis les clés `sb_publishable_…`, la racine `/rest/v1/` répond
   * 401 et non 400. L'ancienne sonde ne l'acceptait pas et déclarait la base
   * injoignable alors qu'elle répondait. Un 401 est désormais une panne (clé
   * refusée), pas un signe de vie.
   */
  it('clé refusée (401) → 503', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'mauvaise';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: false });
  });

  it('panne réseau → 503', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sb_publishable_x';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────
describe('GET /api/employees', () => {
  it('sans session → 401', async () => {
    h.client = fakeClient({ getUser: () => ({ data: { user: null }, error: null }) });
    const { GET } = await import('@/app/api/employees/route');
    const res = await GET(get('/api/employees'));
    expect(res.status).toBe(401);
  });

  it('un employé (pas le patron) → 403', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: { get_business_owner_id: { data: 'owner-9', error: null } },
    });
    const { GET } = await import('@/app/api/employees/route');
    const res = await GET(get('/api/employees', { authorization: 'Bearer j' }));
    expect(res.status).toBe(403);
  });

  it('le patron → 200 avec ses membres', async () => {
    h.client = fakeClient({
      getUser: () => ({ data: { user: { id: 'u1' } }, error: null }),
      rpc: { get_business_owner_id: { data: 'u1', error: null } },
      from: {
        business_members: {
          data: [{ id: 'm1', member_id: 'u2', member_name: 'Marie', role: 'employee', created_at: '' }],
          error: null,
        },
      },
    });
    const { GET } = await import('@/app/api/employees/route');
    const res = await GET(get('/api/employees', { authorization: 'Bearer j' }));
    expect(res.status).toBe(200);
    expect((await res.json()).members[0].member_name).toBe('Marie');
  });
});
