import { NextResponse } from 'next/server';

/**
 * GET /api/health — sonde de disponibilité.
 *
 * Répond 200 si l'application ET la base sont joignables, 503 sinon. Sert aux
 * outils de supervision (uptime) : un « 200 » signifie « le commerce peut
 * vendre ». Aucune donnée métier, aucun secret : uniquement des booléens.
 *
 * Le ping base est un appel REST léger (3 s de délai maximum) : on ne veut pas
 * qu'une base lente fasse traîner la sonde, ni qu'une sonde bloque une
 * fonction.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    return NextResponse.json({ ok: false, db: false, raison: 'configuration' }, { status: 503 });
  }

  let db = false;
  try {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: anon },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(minuteur);
    // 200 = OK ; 400 = l'API répond (requête vide invalide) — les deux prouvent
    // que PostgREST est joignable.
    db = res.ok || res.status === 400;
  } catch {
    db = false;
  }

  return NextResponse.json(
    { ok: db, db, time: new Date().toISOString() },
    { status: db ? 200 : 503 },
  );
}
