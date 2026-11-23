-- change `hub-model-list`: the Claude models a machine's agent reported (null — never reported), so a hub restart keeps the list.
ALTER TABLE runners ADD COLUMN claude_models jsonb;
