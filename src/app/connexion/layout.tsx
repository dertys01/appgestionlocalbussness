import type { Metadata } from 'next';

// Même arrangement que register/layout.tsx : ce layout ne sert qu'à porter
// `metadata` — un composant 'use client' ne peut pas en exporter. Le
// formulaire de connexion vit à part depuis P8 : la racine du site est la
// page d'accueil publique.
export const metadata: Metadata = {
  title: 'Connexion - GestionLocal',
  description:
    'Connectez-vous à votre boutique GestionLocal : caisse, stocks, dettes clients.',
};

export default function ConnexionLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
