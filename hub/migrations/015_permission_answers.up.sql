-- M4b: answers to AskUserQuestion (question text → answer as the model got it), shown on the resolved card.
ALTER TABLE permission_requests ADD COLUMN answers jsonb;
