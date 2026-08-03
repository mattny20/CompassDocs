-- Did the authorization migrations land correctly on this workspace?
--
-- Read-only. Safe to run against production, on every tenant, at any time.
--   psql "$DATABASE_URL" -f tools/verify-rbac-migration.sql
--
-- Between 0.90 and 0.99 authorization moved out of four places (the role
-- ladder, section-access settings, the newsletter column, and three per-space
-- tables) and into role assignments. Each move ran once at boot, guarded by a
-- marker in `settings`. This checks the result rather than the marker: it
-- compares what the assignments say against the original rows wherever those
-- rows still exist.
--
-- 1.0 drops the three per-space grant tables, so checks 2-4 only apply to a
-- database that has not booted 1.0 yet. They are skipped rather than failed:
-- an audit that starts erroring the day a table goes away is an audit that
-- gets muted and then ignored. Run this BEFORE upgrading to 1.0 if you want
-- the per-space comparison; after the upgrade the assignments are the only
-- copy, and check 7 is the one that matters.
--
-- Every check should read OK. A FAIL is a grant that did not survive the move
-- — which means someone has less access than they did before the upgrade, or
-- (worse) more. Send the output rather than acting on it.

\pset format aligned
\pset border 2
\echo ''
\echo '=== CompassDocs authorization migration audit ==================='
\echo ''

WITH
-- 1. Ladder: every active user's role has a matching global assignment.
ladder AS (
  SELECT count(*) AS missing
    FROM users u
   WHERE u.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id
        WHERE ra.user_id = u.id AND ra.scope_type = 'global' AND r.key = u.role
     )
),
-- 5. Newsletter (0.94): the column and the assignment must agree.
news AS (
  SELECT count(*) AS missing
    FROM users u
   WHERE u.newsletter_role NOT IN ('', 'none')
     AND NOT EXISTS (
       SELECT 1 FROM role_assignments ra
         JOIN roles r ON r.id = ra.role_id
        WHERE ra.user_id = u.id AND r.key = 'newsletter-' || u.newsletter_role
     )
),
-- 6. The seeded roles this all depends on actually exist.
seeded AS (
  SELECT count(*) FILTER (
    WHERE k NOT IN (SELECT key FROM roles)
  ) AS missing
  FROM unnest(ARRAY[
    'viewer','editor','approver','admin',
    'space-member','space-author',
    'announcements-manager','compliance-manager','training-manager',
    'newsletter-contributor','newsletter-approver'
  ]) AS k
),
-- 7. The workspace can still let people back in. If this is 0 nobody can
-- change anyone's access and the workspace is locked out of itself.
admins AS (
  SELECT count(DISTINCT u.id) AS n
    FROM users u
    JOIN role_assignments ra
      ON ra.user_id = u.id
      OR ra.group_id IN (SELECT group_id FROM group_members WHERE user_id = u.id)
    JOIN role_permissions rp ON rp.role_id = ra.role_id
   WHERE u.status = 'active'
     AND ra.scope_type = 'global'
     AND rp.permission = 'user.update_role'
),
-- 8. Which migrations have recorded themselves as done. Only two write a
-- marker; the ladder migration is idempotent by construction and records
-- nothing, so it is verified by check 1 rather than by a flag.
marks AS (
  SELECT count(*) AS n FROM settings
   WHERE key IN ('migrated_delegation_rbac','migrated_space_grants_rbac')
)
SELECT * FROM (
  SELECT 1 AS ord, 'ladder role -> assignment'      AS check,
         (SELECT missing FROM ladder)::text AS detail,
         CASE WHEN (SELECT missing FROM ladder) = 0 THEN 'OK' ELSE 'FAIL - users with no matching role' END AS verdict
  UNION ALL SELECT 5, 'newsletter column -> assignment',
         (SELECT missing FROM news)::text,
         CASE WHEN (SELECT missing FROM news) = 0 THEN 'OK' ELSE 'FAIL - newsletter grants lost' END
  UNION ALL SELECT 6, 'seeded roles present',
         (SELECT missing FROM seeded)::text,
         CASE WHEN (SELECT missing FROM seeded) = 0 THEN 'OK' ELSE 'FAIL - a seeded role is missing' END
  UNION ALL SELECT 7, 'people who can restore access',
         (SELECT n FROM admins)::text,
         CASE WHEN (SELECT n FROM admins) > 0 THEN 'OK' ELSE 'FAIL - workspace is locked out of itself' END
  UNION ALL SELECT 8, 'migration markers recorded',
         (SELECT n FROM marks)::text || ' of 2',
         CASE WHEN (SELECT n FROM marks) = 2 THEN 'OK' ELSE 'CHECK - a migration has not run' END
) t ORDER BY ord;

-- Checks 2-4: only meaningful while the legacy tables are still present.
SELECT to_regclass('public.space_groups') IS NOT NULL AS has_legacy \gset
\if :has_legacy
SELECT * FROM (
  SELECT 2 AS ord, 'space_groups -> space-member' AS check,
         (SELECT count(*) FROM space_groups l WHERE NOT EXISTS (
            SELECT 1 FROM role_assignments ra
              JOIN roles r ON r.id = ra.role_id AND r.key = 'space-member'
             WHERE ra.scope_type = 'space' AND ra.space_id = l.space_id
               AND ra.group_id = l.group_id))::text AS detail
  UNION ALL SELECT 3, 'space_editors -> space-author',
         (SELECT count(*) FROM space_editors l WHERE NOT EXISTS (
            SELECT 1 FROM role_assignments ra
              JOIN roles r ON r.id = ra.role_id AND r.key = 'space-author'
             WHERE ra.scope_type = 'space' AND ra.space_id = l.space_id
               AND ra.user_id = l.user_id))::text
  UNION ALL SELECT 4, 'space_editor_groups -> space-author',
         (SELECT count(*) FROM space_editor_groups l WHERE NOT EXISTS (
            SELECT 1 FROM role_assignments ra
              JOIN roles r ON r.id = ra.role_id AND r.key = 'space-author'
             WHERE ra.scope_type = 'space' AND ra.space_id = l.space_id
               AND ra.group_id = l.group_id))::text
) t2 ORDER BY ord;
\else
\echo 'Checks 2-4 (per-space grant tables): n/a - dropped in 1.0.'
\endif

\echo ''
\echo 'The "detail" column counts what is MISSING, except rows 7 and 8.'
\echo 'A non-zero detail on checks 2-4 means a grant did not survive the move.'
\echo 'Every verdict should read OK. Anything else: capture this output.'
\echo ''
