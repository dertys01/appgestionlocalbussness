-- ═══ Passer des boutiques en plan Pro (test) ═════════════════════
--
-- Le plan est un simple champ texte sur organizations. Aucun abonnement
-- Stripe n'est nécessaire pour débloquer les fonctionnalités : le webhook
-- Stripe ne fait qu'écrire dans cette colonne. On garde organizations comme
-- source de vérité, ce qui permet de tester sans configurer Stripe.
--
-- ⚠ À N'UTILISER QUE POUR TESTER. Sans abonnement Stripe réel, ces clients
--   consomment des fonctionnalités qu'aucun paiement ne finance. Retomber en
--   'free' à la fin (section 5).

-- ─── 1. Voir toutes les boutiques et leur plan ─────────────────
SELECT id, name, slug, plan, onboarding_done, created_at
FROM organizations
ORDER BY created_at DESC;


-- ─── 2. Passer UNE boutique en Pro ────────────────────────────
-- Remplacer l'email entre les guillemets, puis exécuter SEULEMENT ce bloc.
UPDATE organizations
SET plan = 'pro'
WHERE id IN (SELECT id FROM auth.users WHERE email = 'votre-email@exemple.com');


-- ─── 3. Passer PLUSIEURS boutiques en Pro d'un coup ───────────
-- Un email par ligne, chacun entre guillemets simples, séparés par des
-- virgules. Ne PAS écrire plusieurs emails dans une même chaîne : cela
-- formerait une adresse inexistante et l'UPDATE ne ferait rien.
--
-- Exemple :
--   VALUES ('alice@gmail.com'),
--          ('bob@gmail.com'),
--          ('chez.koffi@gmail.com');

UPDATE organizations
SET plan = 'pro'
WHERE id IN (
  SELECT id FROM auth.users WHERE email IN (
    VALUES ('votre-email@exemple.com')
  )
);


-- ─── 4. Vérifier ce qui est passé en Pro ──────────────────────
SELECT o.name, o.plan, o.slug, u.email
FROM organizations o
LEFT JOIN auth.users u ON u.id = o.id
ORDER BY o.plan, o.created_at DESC;


-- ─── 5. Revenir en free à la fin des tests ────────────────────
-- Remet en free TOUTES les boutiques Pro. Sans abonnement Stripe réel, c'est
-- le comportement attendu.
--
-- UPDATE organizations SET plan = 'free' WHERE plan = 'pro';


-- ═══ Ce que 'pro' débloque ═══════════════════════════════════
-- migration_sales_rpc.sql   create_sale() ignore la limite de ventes
--                            (historique illimité)
-- migration_plan_limits.sql produits illimités, au lieu de 30 en free
-- src/app/page.tsx          rapports / prévisions / équipe déverrouillés
--
-- ⚠ Les rapports et prévisions sont verrouillés par l'INTERFACE seule
--   (composants client). Un utilisateur hors plan peut les rendre en
--   appelant Supabase directement. À durcir en base avant toute distribution.
--
-- ⚠ Un client Pro ne peut pas créer d'organisation supplémentaire : le
--   verrou d'unicité du slug l'en empêche. Une seule boutique par compte.
