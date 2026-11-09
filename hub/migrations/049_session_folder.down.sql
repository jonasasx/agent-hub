-- project_bindings and vault_root were not changed: the older hub works as before.
ALTER TABLE catalog_projects DROP COLUMN folder;
ALTER TABLE runners DROP COLUMN default_dir;
