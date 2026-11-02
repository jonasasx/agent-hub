-- M3c: the last time each alert was sent (task 3.10: «не чаще раза в 12 ч» survives a hub restart) and the reports
-- of the Drive import (task 3.12, design D6/D16).
CREATE TABLE alert_state (
  key           text PRIMARY KEY,
  last_sent_at  timestamptz NOT NULL,
  detail        text
);

CREATE TABLE import_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  report       jsonb NOT NULL DEFAULT '{}'::jsonb
);
