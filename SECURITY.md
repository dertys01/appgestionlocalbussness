# Sécurité — incident de fuite de clés

## Où on en est

**La clé service role est encore valide dans l'historique git.** Elle y est
depuis les commits antérieurs à `591c2e7` (« hardcode service role key »). Le
code actuel est propre — aucun secret dans le dernier commit, vérifié par
Gitleaks en CI à chaque push — mais l'historique, lui, les contient encore.

Tant que la clé n'est pas tournée, la purge ne sert à rien : réécrire
l'historique ne révoque pas une clé. L'ordre n'est donc pas négociable.

## Ce qui a été préparé

- La purge est **testée** : simulation sur un clone jetable, 121 commits
  réécrits, 0 occurrence de clé `service_role` ensuite, arbre du dernier commit
  inchangé, suite de tests verte.
- `scripts/purge-secrets.sh` fait le travail, `--check` d'abord (par défaut),
  `--purge` seulement quand c'est décidé.
- Le script remplace les **valeurs exactes** trouvées, pas « tout ce qui
  ressemble à un JWT » : la clé anon est publique par principe, elle sert au
  navigateur, et l'abraser n'aurait aucun intérêt.

## Les deux étapes qui restent — dans cet ordre

### 1. Tourner la clé service role (30 secondes, c'est toi seul)

Dashboard Supabase → Project Settings → API Keys → **service_role** →
Révoquer / Regenerate.

Puis remplacer `SUPABASE_SERVICE_ROLE_KEY` dans les variables Vercel
(Production + Preview) et redéployer. `.env.local` en local.

Tant que cette étape n'est pas faite, ne lance pas la purge.

### 2. Purger l'historique

```bash
./scripts/purge-secrets.sh --check    # relire la liste des clés visées
./scripts/purge-secrets.sh --purge    # réécrit et force-push
```

Après : fermer les pull requests ouvertes sur GitHub (elles sont orphelines) et
supprimer tous les clones locaux pour recloner. Un `git pull` ne rattrape pas
une réécriture d'historique.

`git-filter-repo` est nécessaire : `pip3 install git-filter-repo`.

## Ce qui reste en place entre-temps

- **Gitleaks en CI** (`.github/workflows/ci.yml`) : toute nouvelle fuite fait
  échouer le build.
- **Le code ne lit plus aucune clé en dur** : `requireEnv()` échoue bruyamment
  si une variable manque, au lieu de retomber sur une valeur codée.
- **Sanctuarisation** : anon et service role ne sont jamais imprimées dans les
  messages d'erreur (`sanitizeError`, `src/lib/utils/server.ts`).

## Si la clé a déjà fuité

Une clé service role est un passe-partout : elle contourne la RLS, elle est
donc aussi puissante que l'accès à toutes les données de tous les clients.
Si tu penses qu'elle a été lue par quelqu'un — pas seulement écrite par erreur
— la rotation ne suffit plus : il faut auditer les ventes, les dettes et les
contacts clients, puis prévenir les personnes concernées.