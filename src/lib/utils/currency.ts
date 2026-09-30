/**
 * Formate un montant en FCFA (format Bénin)
 * Ex: 1500 → "1.500 F"
 */

// Instancié une seule fois au chargement du module. Construire un
// Intl.NumberFormat est coûteux, et formatCFA est appelé par cellule de grille,
// par ligne de tableau et par entrée de prévision.
const CFA_FORMATTER = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatCFA(amount: number): string {
  return CFA_FORMATTER.format(amount) + ' F';
}
