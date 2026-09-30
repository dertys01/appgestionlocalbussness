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
  const detail = e instanceof Error ? e.message : String(e);
  console.error(`[${scope}]`, detail);
  return { error: userMessage };
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
    'SUPABASE_SERVICE_ROLE_KEY',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Configuration serveur incomplète : ${missing.join(', ')}`);
  }
}
