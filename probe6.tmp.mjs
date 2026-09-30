// Ajoute des points de trace autour de la section 13 du harness.
import { readFileSync, writeFileSync } from 'fs';
let s = readFileSync('supabase/tests/migration.test.mjs', 'utf8');
s = s.replace(
  "const vendreK = async (items) => {\n  const r = await q(`SELECT create_sale('${items}'::jsonb, 'cash', null) AS v`);",
  "const vendreK = async (items) => {\n  console.log('    [trace] items =', items);\n  const r = await q(`SELECT create_sale('${items}'::jsonb, 'cash', null) AS v`);"
);
writeFileSync('supabase/tests/migration.test.mjs.tmp', s);
console.log('instrumenté');
