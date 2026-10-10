import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Utilitaires serveur.
 *
 * Le point vital : une erreur du client Supabase contient l'en-tête
 * `Authorization: Bearer <clé service role>`. La réponse au client ne doit
 * JAMAIS la contenir, et les logs non plus (on la masque). Une fuite ici est
 * visible par n'importe qui appelle /api/register.
 */

import { serverError, sanitizeError, requireEnv, checkServerEnv } from '@/lib/utils/server';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sanitizeError', () => {
  it('masque les jetons Bearer', () => {
    const e = new Error('Authorization: Bearer eyJhbGciOi-service-role-secret');
    expect(sanitizeError(e)).toBe('Authorization: Bearer [masqué]');
  });

  it('accepte une valeur non-Error et tronque à 300 caractères', () => {
    expect(sanitizeError('boom')).toBe('boom');
    const long = sanitizeError('x'.repeat(400));
    expect(long).toHaveLength(300);
  });
});

describe('serverError', () => {
  it('renvoie un message opaque et journalise la version masquée', () => {
    const espion = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = serverError('register', new Error('Bearer eyJsecret-clé'));

    expect(res).toEqual({ error: 'Erreur interne du serveur. Réessayez dans un moment.' });
    // Le message renvoyé ne contient aucune trace du jeton…
    expect(JSON.stringify(res)).not.toContain('eyJsecret');
    // …et le log est masqué aussi.
    expect(espion).toHaveBeenCalledWith('[register]', 'Bearer [masqué]');
  });

  it('accepte un message utilisateur personnalisé', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(serverError('x', new Error('y'), 'Indisponible.')).toEqual({ error: 'Indisponible.' });
  });
});

describe('requireEnv', () => {
  it('lève quand la variable manque, en la nommant', () => {
    delete process.env.TEST_VAR_ABSENTE;
    expect(() => requireEnv('TEST_VAR_ABSENTE')).toThrow(/TEST_VAR_ABSENTE/);
  });

  it('renvoie la valeur présente', () => {
    process.env.TEST_VAR_PRESENTE = 'ok';
    expect(requireEnv('TEST_VAR_PRESENTE')).toBe('ok');
    delete process.env.TEST_VAR_PRESENTE;
  });
});

describe('checkServerEnv', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('lève si une variable critique manque', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x';
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => checkServerEnv()).toThrow(/ANON_KEY/);
  });

  it('AVERTIT (sans lever) quand la clé service role manque', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => checkServerEnv()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SUPABASE_SERVICE_ROLE_KEY'));
  });

  it('ne dit rien quand tout est présent', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkServerEnv();
    expect(warn).not.toHaveBeenCalled();
  });
});
