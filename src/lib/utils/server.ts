/**
 * Utilitaires serveur partagés.
 *
 * Raison d'être : une erreur du client Supabase inclut l'en-tête
 * Authorization dans son message. Renvoyer `String(e)` au client exposait
 * donc la clé service role dans la réponse — visible par n'importe qui
 * tente de s'inscrire. Sur Vercel, SUPABASE_SERVICE_ROLE_KEY n'était pas
 * définie au premier déploiement, ce qui a rendu la fuite immédiate.
 */

/**
 * Erreur volontairement opaque pour le client, mais tracée côté serveur.
 * Le message technique va dans les logs Vercel, jamais dans la réponse.
 */
export function serverError(
  scope: string,
  e: unknown,
  userMessage = 'Erreur interne du serveur. Réessayez dans un moment.'
): { error: string } {
  console.error(`[${scope}]`, sanitizeError(e));
  return { error: userMessage };
}

/**
 * Message d'erreur sûr à journaliser.
 *
 * L'erreur du client Supabase inclut l'en-tête `Authorization: Bearer <clé>` :
 * loguer l'objet brut ou son message tel quel consignait la clé service role
 * dans les logs Vercel. On retire tout jeton Bearer, on tronque, et on ne
 * garde que le message (jamais la pile ni la requête à l'origine de l'erreur).
 */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/Bearer\s+\S+/gi, 'Bearer [masqué]').slice(0, 300);
}

/**
 * Vérifie qu'une variable d'environnement serveur est présente.
 *
 * Les routes API l'appellent AVANT tout appel réseau : createClient(url,
 * undefined) renvoyait une erreur d'en-tête invalide contenant la clé.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variable d'environnement manquante : ${name}. ` +
        'La définir dans les variables Vercel puis redéployer.'
    );
  }
  return value;
}

/** Liste les variables serveur critiques, à vérifier au démarrage. */
export function checkServerEnv(): void {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Configuration serveur incomplète : ${missing.join(', ')}`);
  }

  // La clé service role n'est PAS dans la liste bloquante : sans elle,
  // l'inscription et la facturation répondent 503, et tout le reste
  // fonctionne. L'exiger ici ferait échouer le démarrage — donc tout le site —
  // pour une variable qui n'affecte que deux parcours. Les routes concernées la
  // lisent au moment de l'appel et disent ce qui manque. Voir SECURITY.md.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      '[config] SUPABASE_SERVICE_ROLE_KEY absente : /api/register, ' +
      '/api/invitations/accept, /api/stripe/* et /api/payments/* ' +
      'répondront 503.'
    );
  }
}
