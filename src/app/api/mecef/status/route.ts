import { NextRequest, NextResponse } from 'next/server';
import { readUser } from '@/lib/utils/user-client';
import { etatLiaison } from '@/lib/mecef';

/**
 * GET /api/mecef/status — la connexion e-MECeF est-elle ouverte ?
 *
 * La caisse a besoin de ce verdict pour décider d'afficher le bouton
 * « Facture normalisée » (verrou : IFU + connexion). Le jeton DGI reste
 * serveur : seul un booléen traverse, jamais le motif ni la présence du
 * jeton en clair.
 *
 * Lecture exigeant une session (et non le patron seulement) : un·e
 * caissier·e délivre les reçus et les factures au comptoir. En cas de
 * doute la réponse est « fermé » : le verrou ne s'ouvre pas par erreur,
 * et le reçu simple reste toujours disponible.
 */
export async function GET(req: NextRequest) {
  const user = await readUser(req);
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  try {
    return NextResponse.json({ branche: etatLiaison().branche });
  } catch {
    return NextResponse.json({ branche: false });
  }
}
