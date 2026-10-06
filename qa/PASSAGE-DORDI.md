# Changer de machine

Guide pour reprendre le projet sur un autre ordinateur — écrit lors du passage
d'un MacBook Pro Intel (x64) à un MacBook Pro M2 Pro (arm64).

## La règle qui évite 90 % des ennuis

> **La base de données est en ligne. Le code est en ligne. Il n'y a donc rien
> de volumineux à transporter.** Ce qui ne se copie pas, ce sont des fichiers
> locaux — et il n'y en a que trois.

## Ce qui est déjà ailleurs : ne rien transporter

| Quoi | Où | Conséquence |
|---|---|---|
| Base de données | projet Supabase, dans le cloud | schéma, 34 migrations, données, comptes de test : rien à migrer |
| Code | GitHub | `git clone` suffit |
| Chromium (Playwright) | cache par machine | à retélécharger (voir plus bas) |

C'est la seule chose qui rend le projet portable : **aucune base locale n'est
requise**. Les tests tournent sur PGlite, un PostgreSQL compilé en WebAssembly,
donc ni Docker ni `supabase start` — rien à installer ni à migrer.

## Ce qui n'existe que sur la machine actuelle : trois choses

1. **Les commits non poussés.** Vérifier avant tout, sur l'ancienne machine :

   ```bash
   git log --oneline origin/main..HEAD
   ```

   Si la commande affiche des lignes, le travail est encore local. Il faut le
   pousser avant d'éteindre.

2. **`.env.local`** à la racine du dépôt. Il est ignoré par git — c'est voulu,
   il contient des clés. Il porte l'URL Supabase, la clé publishable et la clé
   `service_role`. **`service_role` n'existe pas dans `.env.local.example`** :
   la recopier depuis le fichier réel, pas depuis l'exemple.

3. **`qa/COMPTES.local.md`** : les identifiants des comptes de test. Ignoré par
   git lui aussi, donc absent du clone.

## Ce qu'il ne faut surtout PAS copier

| Quoi | Pourquoi |
|---|---|
| `node_modules/` | binaires compilés pour x86_64. Sur Apple Silicon ils ne se chargent pas, et les plusoi ne se recompilent pas. `npm ci` à la place. |
| `.next/` | cache de construction, lié aux chemins absolus de l'ancienne machine |
| `qa/shots/` | captures régénérées à chaque audit |
| `~/.npm`, `~/.cache` | purement accélératifs |

Copier `node_modules` est le piège classique : l'installation « fonctionne »
et l'erreur n'apparaît qu'au lancement, avec un message de module natif
incompréhensible.

## Sur la nouvelle machine

```bash
# 1. Node — la CI utilise 22. La 24 a été utilisée et passe aussi.
brew install node@22
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node -v

# 2. Le code
git clone https://github.com/dertys01/appgestionlocalbussness.git
cd appgestionlocalbussness

# 3. Les dépendances, compilées pour arm64
npm ci

# 4. Le fichier de configuration : le recopier depuis l'ancienne machine
#    (AirDrop, clé USB, ou le passer par un gestionnaire de mots de passe)
cp /chemin/vers/ancien/.env.local .env.local
chmod 600 .env.local

# 5. Le navigateur des scripts de QA (~100 Mo, une fois)
npx playwright install chromium

# 6. Vérifier
npm run build
npm test
```

`npm ci` est à préférer à `npm install` : il installe exactement ce que le
fichier de verrouillage décrit, ce qui évite qu'une dépendance diffère entre
les deux machines.

## Vérifier que tout est bon

```bash
npm run build        # doit se terminer sans erreur
npm test             # 0 échec
npm run qa:audit     -- <email> '<motdepasse>' retail
npm run qa:parcours  -- <email> '<motdepasse>' retail
```

Les chiffres attendus au moment de l'écriture : 63 écrans et 30 vérifications
en commerce, 68 écrans et 41 vérifications en restaurant, 0 problème partout.
`qa/README.md` décrit les deux outils.

Les identifiants des comptes de test sont dans `qa/COMPTES.local.md`, à copier
depuis l'ancienne machine.

## Après avoir tout vérifié

La base ne demande aucune action : elle est en ligne et partagée. Si les
scripts de QA échouent tous en « connexion impossible » sur la nouvelle
machine, ce n'est pas la base — c'est `QA_BASE` qui pointe encore sur l'ancien
port.

## À savoir sur la clé `service_role`

Elle est nécessaire pour trois choses seulement : `/api/register` (création de
compte), `/api/invitations/accept` et `/api/stripe/*`. Elle **contourne toute la
règle de sécurité de la base**.

Elle est donc à traiter comme un secret : ne jamais la versionner, ne jamais la
copier dans un canal non chiffré, et la révoquer sur le tableau de bord
immédiatement en cas de doute. `SECURITY.md` détaille la marche à suivre.

Si elle est absente, l'application démarre et fonctionne : seules l'inscription
et la facturation répondent 503.