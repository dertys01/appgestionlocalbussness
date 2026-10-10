'use client';

import { LoginPage } from '@/components/auth/LoginPage';

/**
 * L'inscription : la page de connexion ouverte sur l'onglet « Inscription ».
 *
 * Le formulaire vivait ici EN DOUBLE (mêmes champs, même appel `/api/register`,
 * même `setSession`) — deux copies, donc deux occasions de diverger, et le
 * rate-limit d'inscription devait être vérifié deux fois. `/register` est
 * désormais le même composant, démarré en mode inscription.
 */
export default function RegisterPage() {
  return <LoginPage initialMode="register" />;
}
