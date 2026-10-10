'use client';

/**
 * Filet ultime : une erreur dans le layout racine lui-même.
 *
 * `global-error.tsx` remplace TOUT le document, donc ni Tailwind ni le
 * provider Supabase ne sont disponibles ici : styles en ligne, sans dépendance.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f8fafc', color: '#0f172a', margin: 0 }}>
        <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 360, textAlign: 'center' }}>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>Une erreur est survenue</h1>
            <p style={{ fontSize: 14, color: '#475569', marginTop: 8 }}>
              Rechargez la page pour continuer.
            </p>
            <button
              onClick={reset}
              style={{ marginTop: 16, padding: '10px 16px', borderRadius: 8, border: 0, background: '#4f46e5', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
            >
              Réessayer
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
