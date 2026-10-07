/**
 * Numéro au format attendu par wa.me : chiffres seuls, indicatif pays compris.
 *
 * Même règle que normalize_phone() (supabase/migration_telephone_benin.sql) :
 *   8 chiffres                    → 229 + numéro (ancien format béninois)
 *   10 chiffres commençant par 01 → 229 + numéro (format béninois depuis fin 2024)
 *   le reste                      → inchangé (déjà international)
 *
 * Appliquée aussi côté application parce que des fiches anciennes, ou laissées
 * telles quelles par la migration pour ne pas créer de doublon, peuvent encore
 * porter un numéro sans indicatif : la relance doit marcher quand même.
 */
export function whatsappNumber(raw: string): string {
  const d = raw.replace(/[^\d]/g, '');
  if (d.length === 8) return `229${d}`;
  if (d.length === 10 && d.startsWith('01')) return `229${d}`;
  return d;
}
