import type { Metadata } from 'next';

// Le segment dynamique [token] reste côté client : le jeton y est échangé
// contre un compte. Seul le titre du onglet est rendu par le serveur.
export const metadata: Metadata = {
  title: "Accepter l'invitation - GestionLocal",
  description:
    "Choisissez votre mot de passe pour rejoindre la boutique qui vous a invité.",
};

export default function InvitationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
