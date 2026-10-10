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
 *
 * On interroge une table réelle (`products`, une ligne) plutôt que la racine
 * `/rest/v1/` : un 200 prouve les trois maillons — PostgREST joignable, clé
 * acceptée, table lisible. La racine ne suffisait plus : depuis les clés
 * `sb_publishable_…`, elle répond 401 (et non 400), ce qui faisait passer une
 * base saine pour injoignable.
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
    const res = await fetch(`${url}/rest/v1/products?select=id&limit=1`, {
      headers: { apikey: anon },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(minuteur);
    // 200 = PostgREST joignable ET clé acceptée. Un 401 (clé invalide) ou un
    // 5xx est une panne pour le commerce : on ne le masque pas.
    db = res.ok;
  } catch {
    db = false;
  }

  return NextResponse.json(
    { ok: db, db, time: new Date().toISOString() },
    { status: db ? 200 : 503 },
  );
}
