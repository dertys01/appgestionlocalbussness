// Next.js 16 / Sentry 10 : le chargement client passe par ce fichier, pas par
// sentry.client.config.ts (qui n'est plus importé automatiquement) — sans lui
// aucune erreur navigateur ne remontait.
import '../sentry.client.config';
