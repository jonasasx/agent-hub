-- M2.1: the workspace belongs to the browser window (design D6, D10, D11). The server keeps only the last changed
-- workspace of each device class as the template of a new window: no tabs table, no optimistic version.
DROP TABLE open_tabs;
ALTER TABLE ui_layouts DROP COLUMN version;
ALTER TABLE ui_layouts ADD COLUMN opened_at jsonb;
