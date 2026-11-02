-- M2.1 review: the window's clock (ms) of the change a layout snapshot carries. A late PUT (keepalive on pagehide)
-- with an older change must not overwrite the template written by a later change in another window (design D10).
ALTER TABLE ui_layouts ADD COLUMN client_ts bigint;
