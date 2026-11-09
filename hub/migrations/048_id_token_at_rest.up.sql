-- Change idtoken-at-rest-denied-logout (D1): the id_token of a login is kept encrypted with the hub's key (AAD — the
-- session's id_hash). The hub re-encrypts the plaintext `id_token` of older sessions on start and erases it (D2).
ALTER TABLE auth_sessions ADD COLUMN id_token_enc bytea;
