UPDATE projects SET color_key='none' WHERE color_key NOT IN ('scanner','platform','customers','support','infra','tools','org','ext','personal','none');
DROP TABLE hidden_project_groups;
DROP INDEX catalog_projects_active_name;
ALTER TABLE catalog_projects DROP COLUMN color_key;
