'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { Button } from '@/components/ui/button';

/**
 * Frontière d'erreur de la route (App Router).
 *
 * Dernier filet : une exception qui échapperait aux frontières par module
 * remplace la page par ce message au lieu d'une page blanche. Sentry garde la
 * trace pour la correction ; l'utilisateur, lui, ne voit rien de technique.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-sm w-full text-center space-y-4">
        <h1 className="text-xl font-bold text-slate-800">Une erreur est survenue</h1>
        <p className="text-sm text-slate-600">
          L&apos;écran n&apos;a pas pu s&apos;afficher. Vos données ne sont pas perdues.
        </p>
        <Button onClick={reset} className="w-full bg-indigo-600 hover:bg-indigo-700">
          Réessayer
        </Button>
      </div>
    </main>
  );
}
