# Sécurité — incident de fuite de clés

## Où on en est : clos

Les clés Supabase commitées dans l'historique git ont été **révoquées puis
purgées**, dans cet ordre. Les deux étapes sont vérifiées, pas déclarées.

### 1. Les clés sont mortes (le geste qui compte)

Les trois clés trouvées dans l'historique ont été appelées en direct après
leur révocation :

| Clé | Rôle | Réponse du serveur |
|---|---|---|
| `ec8f258f60b9…` | `service_role` | `401 — Legacy API keys are disabled` |
| `b7564ae9779a…` | `anon` | `401 — Legacy API keys are disabled` |
| `2c7008007ed5…` | `anon` (périmée) | `401 — Invalid API key` |

C'est la preuve qui ferme l'incident : une clé révoquée ne se dévalue pas
« un jour », elle est rejetée maintenant, par le serveur.

### 2. L'historique a été réécrit

`scripts/purge-secrets.sh --purge` : 123 commits réécrits, remplacement des
**valeurs exactes** des clés (pas « tout ce qui ressemble à un JWT » — la clé
anon est publique par principe, elle sert au navigateur, et l'abraser n'aurait
rien protégé). Force-push effectué.

Contrôles après réécriture : 0 clé entière dans l'historique, arbre du dernier
commit identique bit pour bit, 178 tests verts, 0 échec du harnais SQL.

### 3. Ce qui reste — et n'est pas un risque

GitHub sert encore les anciens objets par leur SHA, et c'est vérifiable :
l'API renvoie le contenu d'un vieux fichier contenant l'ancienne clé anon. Le
dépôt n'est plus privately accessible, mais les objets existent jusqu'au
prochain ramasse-miettes de GitHub.

Sans importance, maintenant : ces clés sont **révoquées**. Un objet lisible qui
ne vaut rien n'est pas une fuite.

Pour les faire disparaître quand même, il faut passer par le support GitHub
(leur équipe peut forcer un GC sur demande, uniquement pour une fuite de
secret avérée). À faire seulement si tu veux que le dépôt soit propre sur le
plan documentaire — pas pour la sécurité.

## Les clés actuelles

| Variable | Format | Où |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | — | inchangée |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_…` | Vercel (tous les environnements) + `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` (`default`) | Vercel (Production) + `.env.local` |

Les clés JWT héritées sont désactivées au niveau du projet
(*Disable JWT-based API keys*). L'application ne dépend plus d'elles : le
navigateur utilise la clé publishable, le serveur la secret key.

### Où la clé service role est réellement utilisée

Une clé `service_role` contourne toute la RLS. Elle n'est donc employée que là
où il n'existe pas de session à utiliser, c'est-à-dire trois cas :

| Route | Pourquoi |
|---|---|
| `/api/register` | crée le compte Auth, et le limiteur doit être partagé entre les instances serverless |
| `/api/invitations/accept` | `redeem_invitation()` est privileged : l'appelant est anonyme, c'est le jeton d'invitation qui fait foi |
| `/api/stripe/*` | abonnements et webhooks |

L'**écran Équipe et les invitations** n'en ont plus besoin. Ils utilisaient la
clé pour lire `business_members` — alors que la policy
`owner_manage_members_select` (`auth.uid() = owner_id`) autorise déjà le patron
à lire sa propre équipe — et pour écrire dans `employee_invitations`, dont la
policy est déjà `FOR ALL` sur son propriétaire. Autrement dit, la clé service
réouvrait exactement ce que `migration_security.sql` avait refermé.

Les deux écritures qui restaient (changer un rôle, retirer un membre) passent
désormais par `business_members_set_role()` et `business_members_remove()`, en
SECURITY DEFINER : la table n'a toujours aucune écriture client, et la
vérification « l'appelant est-il le patron de cette équipe ? » vit dans la
fonction, où elle ne peut pas être oubliée.

Conséquence pratique : **sans `SUPABASE_SERVICE_ROLE_KEY`, l'application
démarre, se construit en développement et fonctionne**. Seules l'inscription et
la facturation répondent 503, ce qui est exact.

## Ce qui empêche le retour

- **Gitleaks en CI** (`.github/workflows/ci.yml`) : toute nouvelle fuite fait
  échouer le build.
- **`requireEnv()`** : une variable manquante échoue bruyamment au démarrage,
  au lieu de retomber sur une valeur codée en dur. C'est ce qui avait permis à
  la clé de vivre dans le code.
- **`sanitizeError()`** : plus aucun en-tête `Authorization` dans les logs.
- **`.env.local` en `600`** et non versionné.

## Si une clé privileged fuite un jour

Une clé `service_role` contourne toute la RLS : elle lit les emails de tous les
comptes, toutes les dettes avec numéros de téléphone, et écrit dans n'importe
quelle boutique. Le réflexe, dans l'ordre :

1. **Révoquer** sur le dashboard — c'est le geste qui stoppe l'accès, tout le
   reste est de la propreté.
2. Migrer vers `sb_secret_…` + désactiver les clés JWT héritées.
3. Vérifier, **en appelant l'ancienne clé** et en montrant le 401.
4. Purger l'historique.
5. Auditer ce qui a pu être lu : ventes, dettes, contacts. Et prévenir les
   personnes concernées — c'est la partie qu'on oublie toujours.