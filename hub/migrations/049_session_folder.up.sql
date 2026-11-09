-- Change session-folder (D1): the default folder of a machine (absolute, where its sessions start) and the folder of a
-- catalog project relative to it, the same on every machine. VAULT_ROOT of the agent is only the initial value.
ALTER TABLE runners ADD COLUMN default_dir text;
ALTER TABLE catalog_projects ADD COLUMN folder text CHECK (folder IS NULL OR length(folder) BETWEEN 1 AND 1000);

UPDATE runners SET default_dir = coalesce(vault_root, home_dir);

-- The folder of a project: its binding relative to the default folder of the binding's machine, '/' as the separator,
-- case-insensitive prefix on Windows. Bindings outside the default folder are dropped; the most recently seen machine
-- wins; a binding equal to the default folder means no folder. project_bindings stays as it is (rollback).
WITH b AS (
  SELECT b.user_id,
         b.project_id,
         r.last_seen_at,
         r.default_dir ~ '^[A-Za-z]:' AS win,
         rtrim(replace(b.path, '\', '/'), '/') AS p,
         rtrim(replace(r.default_dir, '\', '/'), '/') AS d
  FROM project_bindings b
  JOIN runners r ON r.user_id = b.user_id AND r.id = b.runner_id
  WHERE r.default_dir IS NOT NULL
), inside AS (
  SELECT DISTINCT ON (user_id, project_id)
         user_id,
         project_id,
         substr(p, length(d) + 2) AS rel
  FROM b
  WHERE CASE WHEN win THEN lower(p) = lower(d) OR left(lower(p), length(d) + 1) = lower(d) || '/'
             ELSE p = d OR left(p, length(d) + 1) = d || '/' END
  ORDER BY user_id, project_id, last_seen_at DESC NULLS LAST
)
UPDATE catalog_projects c
SET folder = nullif(i.rel, '')
FROM inside i
WHERE c.user_id = i.user_id AND c.id = i.project_id;
