#!/usr/bin/env bash
#
# Purge des clés Supabase commitées dans l'historique git.
#
#   ./scripts/purge-secrets.sh --check    vérifie, ne modifie rien (défaut)
#   ./scripts/purge-secrets.sh --purge    réécrit l'historique puis force-push
#
# ⚠ NE JAMAIS PURGER AVANT D'AVOIR TOURNÉ LA CLÉ SERVICE ROLE DANS LE DASHBOARD.
# Réécrire l'historique ne révoque rien : la clé reste valide, et elle reste
# dans les clones, les forks et les caches de GitHub tant qu'elle n'est pas
# tournée. L'ordre est dans SECURITY.md.
#
# Le remplacement se fait par la valeur exacte des clés trouvées dans
# l'historique, pas par une expression large : « remplacer tout ce qui ressemble
# à un JWT » abraserait des choses légitimes, y compris la clé anon — qui est
# publique par principe et sert au navigateur.
#
# Effet de bord assumé : tous les identifiants de commit changent. Les clones
# existants doivent être supprimés et refaits, pas « mis à jour ».
#
# Écrit en bash 3.2 (celui de macOS) : pas de mapfile, pas de namerefs.

set -euo pipefail

MODE="${1:---check}"
RACINE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RACINE"

# La valeur exacte des clés, lue dans l'historique et jamais écrite en clair
# dans ce fichier — lui-même versionné.
LISTE=$(mktemp)
TEXTE=$(mktemp)
trap 'rm -f "$LISTE" "$TEXTE"' EXIT

git log --all -p 2>/dev/null \
  | grep -oE 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' \
  | sort -u > "$LISTE" || true

NB=$(wc -l < "$LISTE" | tr -d ' ')
if [ "$NB" -eq 0 ]; then
  echo "Aucune clé Supabase dans l'historique. Rien à faire."
  exit 0
fi

echo "Clés trouvées dans l'historique : $NB"
while IFS= read -r c; do
  [ -z "$c" ] && continue
  role=$(python3 - "$c" <<'PY'
import base64, json, sys
p = sys.argv[1].split('.')[1]
p += '=' * (-len(p) % 4)
print(json.loads(base64.urlsafe_b64decode(p)).get('role', '?'))
PY
)
  echo "  - rôle : $role (${#c} caractères)"
  printf '%s==>SUPABASE_KEY_A_ROTATIONNER\n' "$c" >> "$TEXTE"
done < "$LISTE"

if [ "$MODE" = "--check" ]; then
  cat <<'FIN'

Vérification seulement — rien n'a été modifié.

Pour purger, après avoir TOURNÉ la clé service role dans le dashboard Supabase
et mis à jour les variables Vercel :

    ./scripts/purge-secrets.sh --purge
FIN
  exit 0
fi

if [ "$MODE" != "--purge" ]; then
  echo "Option inconnue : $MODE" >&2
  exit 2
fi

command -v git-filter-repo >/dev/null 2>&1 || true
if ! python3 -c 'import git_filter_repo' >/dev/null 2>&1; then
  echo "git-filter-repo est requis : pip3 install git-filter-repo" >&2
  exit 1
fi

echo
echo "Réécriture de l'historique…"
python3 -m git_filter_repo --force --replace-text "$TEXTE"

RESTANT=$(git log --all -p 2>/dev/null \
  | grep -cE 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' || true)
if [ "$RESTANT" != "0" ]; then
  echo "ÉCHEC : il reste $RESTANT clé(s) dans l'historique. Ne pas pousser." >&2
  exit 1
fi

echo "Historique purgé. Force-push…"
git push --force --mirror origin

cat <<'FIN'

Terminé. À faire maintenant :

  1. Sur GitHub : fermer les pull requests ouvertes — elles sont devenues
     orphelines — et prévenir les forks éventuels.
  2. Supprimer tous les clones locaux existants et recloner. Un `git pull` ne
     rattrape pas une réécriture d'historique.
FIN