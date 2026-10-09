import type { Metadata } from 'next';

// Ce layout ne sert qu'à porter `metadata` : un composant 'use client' ne peut
// pas en exporter. La page reste intégralement côté client (formulaire +
// redirection), seul le titre du onglet est rendu par le serveur.
export const metadata: Metadata = {
  title: 'Créer un compte - GestionLocal',
  description:
    'Créez votre compte GestionLocal et donnez un nom à votre boutique. Plan gratuit, aucune carte bancaire requise.',
};

export default function RegisterLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
