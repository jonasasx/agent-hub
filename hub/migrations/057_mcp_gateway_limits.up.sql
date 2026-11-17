-- change `mcp-gateway-session-limits`: gateway limits of a machine (null — the agent defaults) and the reason of a refused gateway start.
ALTER TABLE runners ADD COLUMN mcp_gateway_limits jsonb;
ALTER TABLE mcp_gateway_statuses ADD COLUMN reason jsonb;
