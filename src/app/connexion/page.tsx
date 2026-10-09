'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import { LoginPage } from '@/components/auth/LoginPage';
import { useSupabase } from '@/components/providers/SupabaseProvider';

/**
 * Le formulaire de connexion (P8).
 *
 * Avant, il était rendu par la racine du site quand il n'y avait pas de
 * session. La racine sert désormais la page d'accueil publique : le
 * formulaire a sa propre adresse, partageable et favoritesable.
 *
 * Une session déjà ouverte (redemption d'invitation, mot de passe réinitialisé,
 * ou connexion réussie ici même) ne doit pas afficher un formulaire de
 * connexion : la page ramène à la racine, qui montre alors l'application.
 */
export default function ConnexionPage() {
  const { user, loading } = useSupabase();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace('/');
  }, [user, loading, router]);

  if (!loading && user) return null;

  return <LoginPage />;
}
