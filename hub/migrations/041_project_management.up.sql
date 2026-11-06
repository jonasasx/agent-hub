-- Refuse ambiguous active names before changing the schema. Operators must resolve these explicitly.
DO $$
DECLARE duplicates text;
BEGIN
  SELECT string_agg(user_id::text || ': ' || normalized || ' (' || ids || ')', '; ')
    INTO duplicates FROM (
      SELECT user_id, lower(normalize(btrim(name), NFC)) AS normalized, string_agg(id::text, ', ' ORDER BY id) AS ids
      FROM catalog_projects WHERE NOT archived GROUP BY user_id, lower(normalize(btrim(name), NFC)) HAVING count(*) > 1
    ) d;
  IF duplicates IS NOT NULL THEN RAISE EXCEPTION 'Duplicate active project names: %', duplicates; END IF;
END $$;
ALTER TABLE catalog_projects ADD COLUMN color_key text;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS n FROM catalog_projects
)
UPDATE catalog_projects p SET color_key = (ARRAY['scanner','platform','customers','support','infra','tools','org','ext','personal','rose','lime','slate'])[((r.n - 1) % 12 + 1)::int]
FROM ranked r WHERE p.id = r.id;
ALTER TABLE catalog_projects ALTER COLUMN color_key SET NOT NULL;
ALTER TABLE catalog_projects ALTER COLUMN color_key SET DEFAULT 'scanner';
ALTER TABLE catalog_projects ADD CONSTRAINT catalog_projects_color_key_check CHECK (color_key IN ('scanner','platform','customers','support','infra','tools','org','ext','personal','rose','lime','slate'));
CREATE UNIQUE INDEX catalog_projects_active_name ON catalog_projects(user_id, lower(normalize(btrim(name), NFC))) WHERE NOT archived;
-- A hidden group retains its legacy row and all session data.
CREATE TABLE hidden_project_groups (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, project_id)
);

-- Keep assigned legacy keys, repairing only absent or invalid values.
DO $$
DECLARE project record; chosen text;
BEGIN
  FOR project IN SELECT id, user_id, path FROM projects
    WHERE color_key IS NULL OR color_key NOT IN ('scanner','platform','customers','support','infra','tools','org','ext','personal','rose','lime','slate') ORDER BY user_id, path
  LOOP
    SELECT palette.key INTO chosen FROM unnest(ARRAY['scanner','platform','customers','support','infra','tools','org','ext','personal','rose','lime','slate']) AS palette(key)
    LEFT JOIN projects p ON p.user_id=project.user_id AND p.color_key=palette.key
    GROUP BY palette.key ORDER BY count(p.id), hashtextextended(project.path || ':' || palette.key, 0), palette.key LIMIT 1;
    UPDATE projects SET color_key=chosen WHERE id=project.id;
  END LOOP;
END $$;
