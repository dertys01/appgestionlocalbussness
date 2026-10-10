import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Webhook de paiement — la SEULE porte d'activation d'un plan.
 *
 * Fail-closed à chaque étape : passerelle inconnue/non configurée, callback non
 * vérifié, commande introuvable, commande d'un AUTRE (jeton volé), absence de
 * clé service role — aucun de ces cas n'active quoi que ce soit.
 */

const h = vi.hoisted(() => {
  const state = {
    prestataire: { id: 'sandbox', verifierCallback: (() => null) as () => { ok: boolean; reference: string } | null },
    getUser: { data: { user: { id: 'u1' } as { id: string } | null }, error: null as null | { message: string } },
    rpcOwner: { data: 'u1' as unknown, error: null as null | { message: string } },
    rpcActivate: { data: true as unknown, error: null as null | { message: string } },
    commande: { data: { user_id: 'u1' } as { user_id: string } | null, error: null as null | { message: string } },
  };
  const client = {
    auth: { getUser: async () => state.getUser },
    rpc: async (fn: string) => {
      if (fn === 'get_business_owner_id') return state.rpcOwner;
      if (fn === 'activate_prepaid_plan') return state.rpcActivate;
      return { data: null, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => state.commande }) }) }),
  };
  return { state, client };
});

vi.mock('@/lib/payments', () => ({ getPrestataire: () => h.state.prestataire }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }));

import { POST } from '@/app/api/payments/callback/[provider]/route';

const req = (body = '{}') =>
  new NextRequest(new URL('http://localhost/api/payments/callback/sandbox'), {
    method: 'POST',
    headers: { authorization: 'Bearer j', 'content-type': 'application/json' },
    body,
  });
const ctx = { params: Promise.resolve({ provider: 'sandbox' }) };

const original = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
  h.state.prestataire = { id: 'sandbox', verifierCallback: () => ({ ok: true, reference: 'REF-1' }) };
  h.state.getUser = { data: { user: { id: 'u1' } }, error: null };
  h.state.rpcOwner = { data: 'u1', error: null };
  h.state.rpcActivate = { data: true, error: null };
  h.state.commande = { data: { user_id: 'u1' }, error: null };
});

afterEach(() => { process.env = { ...original }; });

describe('POST /api/payments/callback/[provider] — activation', () => {
  it('active une commande du patron courant', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activated: true });
  });

  it('activated=false quand la base dit que rien n’a changé (idempotence)', async () => {
    h.state.rpcActivate = { data: false, error: null };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activated: false });
  });

  it('refuse une commande qui n’appartient pas à l’appelant (jeton volé) → 403', async () => {
    h.state.commande = { data: { user_id: 'autre' }, error: null };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('commande introuvable → 404', async () => {
    h.state.commande = { data: null, error: null };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(404);
  });

  it('callback non vérifié (prestataire non branché) → 400, aucun effet', async () => {
    h.state.prestataire = { id: 'sandbox', verifierCallback: () => null };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(400);
  });

  it('appelant non patron → 403', async () => {
    h.state.rpcOwner = { data: 'owner-9', error: null };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
  });

  it('sans clé service role → 503 (fail closed)', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await POST(req(), ctx);
    expect(res.status).toBe(503);
  });

  it('échec d’activation en base → 500 opaque', async () => {
    h.state.rpcActivate = { data: null, error: { message: 'Bearer srk fuite éventuelle' } };
    const res = await POST(req(), ctx);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('srk');
  });
});
