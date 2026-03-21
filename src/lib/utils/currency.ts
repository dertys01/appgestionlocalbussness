/**
 * Formate un montant en FCFA (format Bénin)
 * Ex: 1500 → "1.500 F"
 */
export function formatCFA(amount: number): string {
  return (
    new Intl.NumberFormat('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount) + ' F'
  );
}
