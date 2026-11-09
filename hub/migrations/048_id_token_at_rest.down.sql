-- The ciphertexts cannot be decrypted in SQL: the older hub logs out without id_token_hint, sessions stay.
ALTER TABLE auth_sessions DROP COLUMN id_token_enc;
