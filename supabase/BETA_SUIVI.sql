-- ============================================================
-- BÊTA — suivi des testeurs et de leurs retours
-- À coller dans Supabase SQL Editor
--
-- Ce fichier ne s'exécute pas d'un bloc : c'est une boîte à outils. Chaque
-- section est indépendante, on les lance une par une.
-- ============================================================


-- ─── 1. Où en est le programme ? ──────────────────────────
-- À lancer pour savoir combien de places restent.
SELECT * FROM beta_status();


-- ─── 2. Qui testé, et ce qu'il en a dit ───────────────────
-- La liste de travail pendant les tests. Les colonnes avis / bugs / manques se
-- remplissent au fil de l'eau, puis se relisent dans cet ordre pour décider
-- quoi corriger en premier.
--
-- Un retour sur un prix qui ne s'affiche pas, ou sur un mot que personne ne
-- comprend, vaut plus qu'un rapport de bug rédigé par un développeur six
-- semaines plus tard.
SELECT
  to_char(granted_at, 'DD/MM')                       AS inscrit_le,
  split_part(email, '@', 1)                          AS compte,
  o.name                                             AS boutique,
  o.plan                                             AS plan_actuel,
  coalesce(teste_le::text, '—')                      AS teste_le,
  coalesce(avis,  '—')                               AS avis,
  coalesce(bugs,  '—')                               AS bugs,
  coalesce(manques, '—')                             AS manques
FROM beta_access b
JOIN organizations o ON o.id = b.user_id
ORDER BY granted_at DESC;


-- ─── 3. Noter un retour ──────────────────────────────────
-- Remplacer l'email et le texte, puis lancer. Un seul UPDATE par testeur.
--
-- UPDATE beta_access SET
--   teste_le = current_date,
--   avis   = 'Il a vendu toute sa journée, ça tient au téléphone.',
--   bugs   = 'Sur les petits écrans, le bouton Encaisser est sous le pouce.',
--   manques = 'Il voudrait un reçu par SMS, pas WhatsApp.'
--  WHERE email = 'son@email.com';


-- ─── 4. Qui n'a pas encore testé ? ────────────────────────
-- Un testeur sans retour n'a pas servi à grand-chose : c'est la première chose
-- à relancer.
SELECT split_part(email, '@', 1) AS compte,
       to_char(granted_at, 'DD/MM/YY') AS inscrit_le,
       CASE WHEN avis IS NULL AND bugs IS NULL THEN 'aucun retour' ELSE 'à relancer' END AS etat
FROM beta_access
WHERE avis IS NULL AND bugs IS NULL AND manques IS NULL
ORDER BY granted_at;


-- ─── 5. Les boutiques les plus utilisées ──────────────────
-- Un défaut n'apparaît qu'à l'usage. Trois ventes en trois jours, c'est une
-- boutique qui teste vraiment ; zéro, c'est un compte mort.
SELECT
  split_part(b.email, '@', 1)              AS compte,
  o.name                                    AS boutique,
  count(DISTINCT s.id)                      AS ventes,
  coalesce(sum(s.amount_received), 0)       AS encaisse,
  count(DISTINCT p.id)                      AS articles
FROM beta_access b
JOIN organizations o ON o.id = b.user_id
LEFT JOIN sales s        ON s.user_id = o.id
LEFT JOIN products p     ON p.user_id = o.id AND p.is_active
GROUP BY b.email, o.name
ORDER BY ventes DESC;


-- ─── 6. Commandes de gestion ──────────────────────────────
-- ── Fermer le programme (les comptes déjà servis gardent l'accès) ──
-- SELECT close_beta_program();

-- ── Deuxième vague : réouvrir avec plus de places ──
-- SELECT set_beta_slots(20);

-- ── Tout retomber en gratuit (les retours sont conservés) ──
-- SELECT revoke_all_beta();

-- ── Rendre l'accès Pro à un testeur en plus, hors budget ──
-- À n'utiliser que pour un cas précis : un testeur VIP, un bug à reproduire
-- qui exige le Pro. C'est une exception, donc elle se note.
-- UPDATE organizations SET plan = 'pro' WHERE id = (
--   SELECT user_id FROM beta_access WHERE email = 'son@email.com');
-- UPDATE beta_access SET plan = 'pro' WHERE email = 'son@email.com';
