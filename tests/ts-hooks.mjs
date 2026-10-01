// Résolution des imports sans extension pour les tests Node.
//
// Les modules de l'application s'importent mutuellement en './currency' — c'est
// la convention Next.js. Le résolveur ESM de Node exige une extension, donc
// importer src/lib/utils/whatsapp.ts depuis un test échoue sur une résolution
// de module, pas sur un défaut de code. Ce hook ajoute simplement '.ts' quand
// le fichier existe.
//
// Il ne s'applique qu'aux tests : le code applicatif n'est pas touché, et
// webpack n'a jamais eu ce problème.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        const chemin = fileURLToPath(new URL(specifier, context.parentURL));
        if (existsSync(chemin + '.ts')) {
          return next(pathToFileURL(chemin + '.ts').href, context);
        }
      } catch {
        // URL relative à un parent absent : on laisse le résolveur normal faire.
      }
    }
    return next(specifier, context);
  },
});
