import type { Metadata } from 'next';

// Même principe que `src/app/register/layout.tsx` : le serveur porte le titre
// du onglet, la page reste un composant client (elle valide le jeton de reset
// auprès de Supabase côté navigateur).
export const metadata: Metadata = {
  title: 'Choisir un nouveau mot de passe — GestionLocal',
  description:
    'Choisissez un nouveau mot de passe pour votre compte GestionLocal.',
};

export default function ResetPasswordLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
