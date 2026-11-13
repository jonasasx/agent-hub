import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_REGISTRY_CAPABILITIES, OAUTH_LOOPBACK_REDIRECT_URI, type SessionView } from '@agent-hub/shared';
import { agentSend, autoReply, connectFakeAgent, PUBLIC_URL, startTestHub, waitFor, type FakeAgent, type TestHub } from '../test/harness.js';
import { decryptToken, tokenKey } from '../subscriptions/crypto.js';

describe('MCP registry draft tools', () => {
  let t: TestHub;
  let cookie: string;
  let agent: FakeAgent;
  let sessionId: string;
  let runnerId: string;
  let userId: string;
  let catalogProjectId: string;
  const logs: string[] = [];
  const fakeAgents: FakeAgent[] = [];
  const secret = 'MCP_REGISTRY_TEST_SECRET_7c3ef3';
  let validationFailureCode: string | null = null;
  let oauthStartFailureCode: string | null = null;
  let validationResult: Record<string, unknown> | null = null;
  let validationHold: (() => void) | null = null;
  let validationStarted = false;
  let separateValidationResult = false;
  let validationResultAbsent = false;
  let spoofValidationReplies = false;
  let foreignValidationAgent: FakeAgent | null = null;
  const request = (op: 'add' | 'list' | 'update', payload: Record<string, unknown>, session = sessionId) => {
    const requestId = randomUUID();
    const before = agent.messages.filter(m => m.type === 'mcp.draft.result').length;
    agentSend(agent, 'mcp.draft.request', { requestId, sessionId: session, op, payload });
    return waitFor(() => {
      const m = agent.messages.filter(x => x.type === 'mcp.draft.result')[before];
      return m?.payload?.requestId === requestId ? m : null;
    });
  };
  const candidate = (name: string) => ({
    server: { id: randomUUID(), name, enabled: true, transport: 'stdio', mode: 'per-session', command: 'node', machineScope: { allMachines: true, machineIds: [] }, projectIds: [] },
  });
  const connectAgent = (token: string, hello: Record<string, unknown>) => {
    const connected = connectFakeAgent(t.wsBase, token, hello);
    fakeAgents.push(connected);
    return connected;
  };

  beforeAll(async () => {
    t = await startTestHub({
      env: { SUBSCRIPTION_TOKEN_KEY: Buffer.alloc(32, 17).toString('base64') },
      logStream: {
        write(line) {
          logs.push(line);
        },
      },
      sessions: { idleCheckMs: 0, initTimeoutMs: 3000 },
      mcpRegistry: { importTimeoutMs: 5000, validationTimeoutMs: 1000 },
    });
    expect(t.config.SUBSCRIPTION_TOKEN_KEY).toBeDefined();
    cookie = await t.login();
    runnerId = 'vm';
    const token = await t.addRunner(runnerId);
    agent = connectAgent(token, { protocol: '1.13', capabilities: [...MCP_REGISTRY_CAPABILITIES] });
    autoReply(agent, (type, payload, requestId) => {
      if (type === 'mcp.registry.validate' && separateValidationResult) {
        if (!requestId) throw new Error('validation command is missing an id');
        const validationPayload = { draftId: payload.draftId, revision: payload.revision, ok: true, status: 'checked', tools: [{ name: 'qa.echo' }], oauthRequired: false };
        if (!validationResultAbsent) {
          if (spoofValidationReplies) {
            agentSend(agent, 'mcp.registry.validate.result', validationPayload, { re: randomUUID() });
            if (foreignValidationAgent) agentSend(foreignValidationAgent, 'mcp.registry.validate.result', validationPayload, { re: requestId });
          }
          agentSend(agent, 'mcp.registry.validate.result', validationPayload, { re: requestId });
        }
        return { resultSent: true };
      }
      return type === 'mcp.registry.validate' && validationResult
        ? {
            draftId: payload.draftId,
            revision: payload.revision,
            tools: [],
            oauthRequired: false,
            ...validationResult,
          }
        : type === 'mcp.registry.validate' && validationHold
          ? new Promise(resolve => {
              validationStarted = true;
              validationHold = () =>
                resolve({
                  draftId: payload.draftId,
                  revision: payload.revision,
                  ok: true,
                  status: 'checked',
                  tools: [],
                  oauthRequired: false,
                });
            })
          : type === 'mcp.registry.validate' && validationFailureCode
            ? (() => {
                throw { code: validationFailureCode, message: 'UNSAFE_DIAGNOSTIC_VALUE' };
              })()
            : type === 'fs.stat'
              ? { exists: true, isDir: true }
              : type === 'session.start'
                ? { models: [] }
                : type === 'mcp.oauth.start' && oauthStartFailureCode
                  ? (() => {
                      throw { code: oauthStartFailureCode, message: 'UNSAFE_AUTH_SERVER_BODY Trusted Hosts insufficient_scope' };
                    })()
                  : type === 'mcp.oauth.start'
                    ? (() => {
                        const state = `hub-oauth-state-${String(payload.flowId)}`;
                        const authUrl = new URL('https://idp.example.test/authorize');
                        authUrl.searchParams.set('redirect_uri', String(payload.redirectUri));
                        authUrl.searchParams.set('state', state);
                        return { flowId: payload.flowId, authorizationUrl: authUrl.toString(), state, expiresAt: Date.now() + 9 * 60_000 };
                      })()
                    : type === 'mcp.registry.validate'
                      ? { draftId: payload.draftId, revision: payload.revision, ok: true, status: 'checked', tools: [], oauthRequired: false }
                      : {};
    });
    await agent.next('welcome');
    userId = (await t.tdb.pool.query<{ id: string }>(`select id from users where email=$1`, ['alice@example.com'])).rows[0]!.id;
    catalogProjectId = (await t.tdb.pool.query<{ id: string }>(`insert into catalog_projects(user_id,name) values($1,$2) returning id`, [userId, 'mcp_registry_project_scope'])).rows[0]!.id;
    await t.tdb.pool.query(`insert into project_bindings(user_id,project_id,runner_id,path) values($1,$2,$3,$4)`, [userId, catalogProjectId, runnerId, 'C:/work']);
    const started = await t.hub.app.inject({
      method: 'POST',
      url: '/api/sessions',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { runnerId, cwd: 'C:/work', model: 'haiku', prompt: 'hello', projectId: catalogProjectId },
    });
    expect(started.statusCode, started.body).toBe(201);
    sessionId = (started.json() as SessionView).id;
    const startCommand = await agent.next('session.start');
    expect(startCommand.payload.projectId).toBe(catalogProjectId);
  }, 120_000);
  afterAll(async () => {
    for (const fakeAgent of fakeAgents) expect(fakeAgent.protocolErrors).toEqual([]);
    agent?.ws.close();
    await t?.close();
  });

  it('derives owner from session and returns forbidden for a foreign session', async () => {
    const foreignSessionId = randomUUID();
    const r = await request('list', { includeDrafts: true }, foreignSessionId);
    expect(r.payload).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const audit = await t.tdb.pool.query<{ action: string }>(`select action from mcp_registry_audit where actor=$1 order by id desc limit 1`, [foreignSessionId]);
    expect(audit.rows[0]?.action).toBe('tool.forbidden');
  });

  it('completes an agent-created draft through the UI API and sends the confirmed session update', async () => {
    const name = `registry_shared_flow_${randomUUID().slice(0, 8)}`;
    const added = await request('add', candidate(name));
    expect(added.payload).toMatchObject({
      ok: true,
      result: {
        draftId: expect.any(String),
        draft: { state: 'checked', server: { name } },
        validation: { ok: true, status: 'checked', tools: [] },
        confirmationUrl: `/s/${sessionId}?mcp=1`,
      },
    });
    const draftId = (added.payload as { result: { draft: { draftId: string } } }).result.draft.draftId;
    const uiRead = await t.hub.app.inject({
      method: 'GET',
      url: `/api/mcp/registry/drafts/${draftId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
    });
    expect(uiRead.statusCode, uiRead.body).toBe(200);
    expect(uiRead.json()).toMatchObject({ draftId, state: 'checked', server: { name } });
    const foreignRunnerId = randomUUID();
    const foreignToken = await t.addRunner(foreignRunnerId, 'mcp_validation_foreign_runner');
    foreignValidationAgent = connectAgent(foreignToken, { protocol: '1.13', capabilities: [...MCP_REGISTRY_CAPABILITIES] });
    autoReply(foreignValidationAgent, () => ({}));
    await foreignValidationAgent.next('welcome');
    const sentBeforeValidation = agent.sentMessages.length;
    const validated = await (async () => {
      separateValidationResult = true;
      spoofValidationReplies = true;
      try {
        return await t.hub.app.inject({
          method: 'POST',
          url: `/api/mcp/registry/drafts/${draftId}/validate`,
          cookies: { ah_session: cookie },
          headers: { origin: PUBLIC_URL },
          payload: { machineId: runnerId, revision: 1 },
        });
      } finally {
        separateValidationResult = false;
        spoofValidationReplies = false;
        foreignValidationAgent.ws.close();
        foreignValidationAgent = null;
      }
    })();
    expect(validated.statusCode, validated.body).toBe(200);
    expect(validated.json()).toMatchObject({ state: 'checked', validation: { tools: [{ name: 'qa.echo' }] } });
    const validateCommand = agent.messages.filter(message => message.type === 'mcp.registry.validate').at(-1)!;
    const validationMessages = agent.sentMessages.slice(sentBeforeValidation);
    const validationResultIndex = validationMessages.findIndex(message => message.type === 'mcp.registry.validate.result' && message.re === validateCommand.id);
    const commandAckIndex = validationMessages.findIndex(message => message.type === 'cmd.ok' && message.re === validateCommand.id);
    expect(validationResultIndex).toBeGreaterThanOrEqual(0);
    expect(commandAckIndex).toBeGreaterThan(validationResultIndex);
    const beforeUpdate = agent.messages.length;
    const confirmed = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const update = await waitFor(() =>
      agent.messages.slice(beforeUpdate).find(message => message.type === 'mcp.registry.session-update' && (message.payload.server as { name?: string } | undefined)?.name === name),
    );
    expect(update.payload).toMatchObject({ sessionId, activation: 'connected-live', server: { name } });
    expect(confirmed.json()).toMatchObject({ server: { name }, state: 'connected' });
    const duplicateConnect = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(duplicateConnect.statusCode).toBe(409);
  });

  it('binds secret-name inputs through validation and delivers the bound value after connect', async () => {
    const name = `registry_bound_secret_${randomUUID().slice(0, 8)}`;
    const secretValue = `BOUND_SECRET_${randomUUID()}`;
    const before = agent.messages.length;
    const added = await request('add', {
      server: {
        ...candidate(name).server,
        env: { API_KEY: { kind: 'secret-name', name: 'API_KEY' } },
      },
      secrets: [{ name: 'API_KEY', value: secretValue }],
    });
    expect(added.payload).toMatchObject({ ok: true, result: { draft: { state: 'checked' }, validation: { ok: true, status: 'checked' } } });
    expect(JSON.stringify(added.payload)).not.toContain(secretValue);
    const draft = (added.payload as { result: { draft: { draftId: string } } }).result.draft;
    const validateCommand = agent.messages.slice(before).find(message => message.type === 'mcp.registry.validate');
    expect(validateCommand?.payload).toMatchObject({
      server: { env: { API_KEY: { kind: 'secret', secretId: expect.any(String) } } },
      secretDelivery: { secrets: [{ name: 'API_KEY', value: secretValue }] },
    });
    const saved = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draft.draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const delivery = await waitFor(() => agent.messages.slice(before).find(message => message.type === 'mcp.secrets.deliver' && message.payload.serverId === saved.json().serverId));
    expect(delivery.payload.secrets).toContainEqual({ name: 'API_KEY', value: secretValue });
  });

  it('stores an unfilled secret-name binding as needs-secret', async () => {
    const name = `registry_missing_named_secret_${randomUUID().slice(0, 8)}`;
    const response = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(name).server,
          env: { API_KEY: { kind: 'secret-name', name: 'API_KEY' } },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ state: 'draft', server: { secrets: [{ name: 'API_KEY', state: 'needs-secret' }] } });
    const saved = await t.tdb.pool.query<{ state: string }>(`select state from mcp_registry_drafts where name=$1`, [name]);
    expect(saved.rows[0]?.state).toBe('draft');
  });

  it('fills a needs-secret binding by name when patching an existing draft', async () => {
    const name = `registry_patch_missing_secret_${randomUUID().slice(0, 8)}`;
    const secretValue = `PATCH_BOUND_SECRET_${randomUUID()}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(name).server,
          env: { API_KEY: { kind: 'secret-name', name: 'API_KEY' } },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json() as { draftId: string; revision: number; server: { env: Record<string, { secretId: string }> } };
    const missingSecretId = draft.server.env.API_KEY!.secretId;

    const patched = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/mcp/registry/drafts/${draft.draftId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: draft.revision, server: {}, secrets: [{ name: 'API_KEY', value: secretValue }] },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const updated = patched.json() as { revision: number; server: { env: Record<string, { secretId: string }>; secrets: Array<{ secretId: string; name: string; state: string }> } };
    expect(updated.server.env.API_KEY!.secretId).not.toBe(missingSecretId);
    expect(updated.server.secrets).toContainEqual(expect.objectContaining({ name: 'API_KEY', state: 'set' }));

    const validated = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId, revision: updated.revision },
    });
    expect(validated.statusCode, validated.body).toBe(200);
    expect(validated.json()).toMatchObject({ state: 'checked' });
    const validationCommand = agent.messages.filter(message => message.type === 'mcp.registry.validate' && message.payload.draftId === draft.draftId).at(-1);
    expect(validationCommand?.payload.secretDelivery).toMatchObject({ secrets: [{ name: 'API_KEY', value: secretValue }] });
  });

  it('rejects a non-UUID sessionId when creating a draft', async () => {
    const response = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { ...candidate(`registry_bad_session_id_${randomUUID().slice(0, 8)}`), sessionId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects draft updates after connect and save-unchecked', async () => {
    const connectedName = `registry_update_connected_${randomUUID().slice(0, 8)}`;
    const connectedDraft = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(connectedName).server },
    });
    const connected = connectedDraft.json() as { draftId: string; revision: number };
    const checked = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${connected.draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId, revision: connected.revision },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const published = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${connected.draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: connected.revision, userConfirmed: true },
    });
    expect(published.statusCode, published.body).toBe(200);
    const connectedUpdate = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/mcp/registry/drafts/${connected.draftId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: connected.revision, server: { command: 'node --version' } },
    });
    expect(connectedUpdate.statusCode).toBe(409);

    const uncheckedName = `registry_update_unchecked_${randomUUID().slice(0, 8)}`;
    const uncheckedDraft = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(uncheckedName).server },
    });
    const unchecked = uncheckedDraft.json() as { draftId: string; revision: number };
    const saved = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${unchecked.draftId}/save-unchecked`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: unchecked.revision, userConfirmed: true },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const uncheckedUpdate = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/mcp/registry/drafts/${unchecked.draftId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: unchecked.revision, server: { command: 'node --version' } },
    });
    expect(uncheckedUpdate.statusCode).toBe(409);
  });

  it('rolls back a draft revision when secret persistence fails during update', async () => {
    const name = `registry_update_atomic_${randomUUID().slice(0, 8)}`;
    const secretName = `ATOMIC_UPDATE_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(name).server },
    });
    const draft = created.json() as { draftId: string; revision: number };
    await t.tdb.pool.query(
      `CREATE FUNCTION reject_mcp_secret_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = '${secretName}' THEN RAISE EXCEPTION 'injected MCP secret write failure'; END IF; RETURN NEW; END $$`,
    );
    await t.tdb.pool.query(`CREATE TRIGGER reject_mcp_secret_insert BEFORE INSERT ON mcp_secrets FOR EACH ROW EXECUTE FUNCTION reject_mcp_secret_insert()`);
    try {
      const failed = await t.hub.app.inject({
        method: 'PATCH',
        url: `/api/mcp/registry/drafts/${draft.draftId}`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: {
          revision: draft.revision,
          server: { env: { API_KEY: { kind: 'secret-name', name: secretName } } },
          secrets: [{ name: secretName, value: `${secretName}_VALUE` }],
        },
      });
      expect(failed.statusCode).toBe(500);
      const stored = await t.hub.app.inject({
        method: 'GET',
        url: `/api/mcp/registry/drafts/${draft.draftId}`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
      });
      expect(stored.json()).toMatchObject({ revision: 1, state: 'draft', server: { secrets: [] } });
      expect((stored.json() as { server: { env?: unknown } }).server.env).toBeUndefined();
      const secret = await t.tdb.pool.query(`SELECT 1 FROM mcp_secrets WHERE draft_id=$1 AND name=$2`, [draft.draftId, secretName]);
      expect(secret.rowCount).toBe(0);
    } finally {
      await t.tdb.pool.query('DROP TRIGGER reject_mcp_secret_insert ON mcp_secrets');
      await t.tdb.pool.query('DROP FUNCTION reject_mcp_secret_insert()');
    }
  });

  it('rejects a secret reference owned by another server before any delivery', async () => {
    const sourceName = `registry_secret_owner_${randomUUID().slice(0, 8)}`;
    const source = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { ...candidate(sourceName), secrets: [{ name: 'API_KEY', value: secret }] },
    });
    expect(source.statusCode, source.body).toBe(201);
    const secretId = (source.json() as { server: { secrets: Array<{ secretId: string }> } }).server.secrets[0]!.secretId;
    const before = agent.messages.length;
    const foreign = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(`registry_foreign_secret_${randomUUID().slice(0, 8)}`).server,
          env: { API_KEY: { kind: 'secret', secretId } },
        },
      },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: 'invalid_input' });
    expect(agent.messages.slice(before).some(message => message.type === 'mcp.secrets.deliver')).toBe(false);
  });

  it('returns invalid_input for malformed URL secret writes and name_taken for direct duplicate creates', async () => {
    const invalidUrl = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(`registry_bad_secret_url_${randomUUID().slice(0, 8)}`).server,
          transport: 'http',
          url: 'not a valid URL',
        },
        secrets: [{ name: 'url:api_key', value: secret }],
      },
    });
    expect(invalidUrl.statusCode).toBe(400);
    expect(invalidUrl.json()).toMatchObject({ error: 'invalid_input' });
    const name = `registry_direct_duplicate_${randomUUID().slice(0, 8)}`;
    const payload = {
      server: {
        ...candidate(name).server,
        transport: 'http',
        command: undefined,
        url: 'https://mcp.example.test/mcp',
      },
    };
    const first = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const duplicate = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'name_taken' });
  });

  it('maps a concurrent unique-index conflict in server creation to name_taken', async () => {
    const name = `registry_unique_race_${randomUUID().slice(0, 8)}`;
    const server = { ...candidate(name).server, revision: 1 };
    const blocker = await t.tdb.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`INSERT INTO mcp_registry_servers (id,user_id,name,config,enabled) VALUES ($1,$2,$3,$4::jsonb,true)`, [server.id, userId, name, JSON.stringify(server)]);
      const creating = t.hub.app.inject({
        method: 'POST',
        url: '/api/mcp/registry',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { server },
      });
      await waitFor(async () => {
        const active = await t.tdb.pool.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%mcp_registry_servers%'`,
        );
        return active.rows.length ? true : null;
      });
      await blocker.query('COMMIT');
      const response = await creating;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'name_taken' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('does not let a stale validation result overwrite a draft edited while checking', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(`registry_validate_race_${randomUUID().slice(0, 8)}`).server },
    });
    const draft = created.json() as { draftId: string; revision: number };
    validationStarted = false;
    validationHold = () => undefined;
    const validating = t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId, revision: draft.revision },
    });
    try {
      await waitFor(() => validationStarted);
      const updated = await t.hub.app.inject({
        method: 'PATCH',
        url: `/api/mcp/registry/drafts/${draft.draftId}`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { revision: draft.revision, server: { command: 'node --version' } },
      });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({ revision: 2, state: 'draft' });
      validationHold?.();
      const staleResult = await validating;
      expect(staleResult.statusCode).toBe(409);
      const stored = await t.hub.app.inject({
        method: 'GET',
        url: `/api/mcp/registry/drafts/${draft.draftId}`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
      });
      expect(stored.json()).toMatchObject({ revision: 2, state: 'draft' });
      const connected = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draft.draftId}/connect`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { revision: 2, userConfirmed: true },
      });
      expect(connected.statusCode).toBe(409);
      expect(connected.json()).toMatchObject({ error: 'validation_required' });
    } finally {
      validationHold = null;
    }
  });

  it('refuses connect when a newer draft revision wins the row lock', async () => {
    const name = `registry_connect_race_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(name).server },
    });
    const draft = created.json() as { draftId: string; revision: number; server: Record<string, unknown> };
    const validated = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId, revision: draft.revision },
    });
    expect(validated.statusCode, validated.body).toBe(200);
    const blocker = await t.tdb.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`UPDATE mcp_registry_drafts SET updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, draft.draftId]);
      const connecting = t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draft.draftId}/connect`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { revision: draft.revision, userConfirmed: true },
      });
      await waitFor(async () => {
        const active = await t.tdb.pool.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%mcp_registry_drafts%'`,
        );
        return active.rows.length ? true : null;
      });
      const secretId = randomUUID();
      const updatedConfig = {
        ...draft.server,
        command: 'node --version',
        revision: draft.revision + 1,
        env: { API_KEY: { kind: 'secret', secretId } },
        secrets: [{ secretId, name: 'API_KEY', state: 'set' }],
      };
      await blocker.query(`UPDATE mcp_registry_drafts SET config=$3::jsonb, revision=$4, state='draft', validation=NULL WHERE user_id=$1 AND id=$2`, [
        userId,
        draft.draftId,
        JSON.stringify(updatedConfig),
        draft.revision + 1,
      ]);
      await blocker.query(`INSERT INTO mcp_secrets (id,user_id,draft_id,name,ciphertext) VALUES ($1,$2,$3,'API_KEY',$4)`, [secretId, userId, draft.draftId, Buffer.from('test-ciphertext')]);
      await blocker.query('COMMIT');
      const response = await connecting;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'revision_conflict' });
      const server = await t.tdb.pool.query(`select 1 from mcp_registry_servers where user_id=$1 and name=$2`, [userId, name]);
      expect(server.rowCount).toBe(0);
      const secret = await t.tdb.pool.query<{ draft_id: string | null; server_id: string | null }>(`select draft_id,server_id from mcp_secrets where id=$1`, [secretId]);
      expect(secret.rows[0]).toEqual({ draft_id: draft.draftId, server_id: null });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('persists an OAuth draft as needs-login and keeps it out of registry snapshots until connected', async () => {
    const name = `registry_needs_auth_${randomUUID().slice(0, 8)}`;
    const authConfig = {
      ...candidate(name).server,
      transport: 'http',
      mode: 'remote',
      url: 'https://oauth-mcp.example.test/mcp',
      machineScope: { allMachines: false, machineIds: [runnerId] },
    };
    const added = await request('add', { server: authConfig });
    expect(added.payload).toMatchObject({ ok: true, result: { draft: { draftId: expect.any(String) } } });
    const draftId = (added.payload as { result: { draft: { draftId: string } } }).result.draft.draftId;
    validationResult = { ok: false, status: 'needs_auth', tools: [], oauthRequired: true };
    try {
      const validated = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draftId}/validate`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: runnerId, revision: 1 },
      });
      expect(validated.statusCode, validated.body).toBe(200);
      expect(validated.json()).toMatchObject({ state: 'needs_auth', validation: { oauthRequired: true } });
      const saved = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draftId}/connect`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { revision: 1, userConfirmed: true },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ state: 'needs-login', server: { name } });
      const serverId = (saved.json() as { serverId: string }).serverId;
      const snapshot = agent.messages.filter(message => message.type === 'mcp.registry.sync').at(-1)?.payload;
      expect(snapshot?.servers).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: serverId })]));
      const statusResponse = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie } });
      expect(statusResponse.json()).toMatchObject({ oauth: [expect.objectContaining({ serverId, state: 'needs-login', validationState: 'needs_auth', connected: false })] });
      agentSend(agent, 'mcp.oauth.token.update', { serverId, machineId: runnerId, accessToken: 'oauth-needs-auth-access-token' });
      await waitFor(() => t.tdb.pool.query(`select 1 from mcp_oauth_tokens where user_id=$1 and server_id=$2`, [userId, serverId]).then(result => result.rowCount));
      validationResult = { draftId: serverId, revision: 1, ok: true, status: 'checked', tools: [], oauthRequired: true };
      separateValidationResult = true;
      let revalidated;
      try {
        revalidated = await t.hub.app.inject({
          method: 'POST',
          url: `/api/mcp/registry/servers/${serverId}/oauth/validate`,
          cookies: { ah_session: cookie },
          headers: { origin: PUBLIC_URL },
          payload: { machineId: runnerId },
        });
      } finally {
        separateValidationResult = false;
      }
      expect(revalidated.statusCode, revalidated.body).toBe(200);
      expect(revalidated.json()).toMatchObject({ state: 'checked' });
      const connected = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/servers/${serverId}/oauth/connect`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: runnerId },
      });
      expect(connected.statusCode, connected.body).toBe(200);
      expect(connected.json()).toMatchObject({ state: 'connected' });
      await waitFor(() =>
        agent.messages.filter(message => message.type === 'mcp.registry.sync').some(message => (message.payload.servers as { id: string }[] | undefined)?.some(server => server.id === serverId)),
      );
    } finally {
      validationResult = null;
    }
  });

  it('runs OAuth through the target agent, encrypts token rotations, reports refresh errors, and revokes', async () => {
    const serverName = `registry_oauth_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(serverName).server,
          transport: 'http',
          mode: 'remote',
          url: 'https://oauth-mcp.example.test/mcp',
          oauthClientId: 'pre-registered-client',
          machineScope: { allMachines: false, machineIds: [runnerId] },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const notAllowed = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/servers/${serverId}/oauth/start`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: randomUUID() },
    });
    expect(notAllowed.statusCode).toBe(403);
    const started = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/servers/${serverId}/oauth/start`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId },
    });
    expect(started.statusCode, started.body).toBe(202);
    const startResult = started.json() as { state: string; authorizationUrl: string; expiresAt: number; serverId: string; machineId: string };
    expect(startResult).toMatchObject({ state: 'pending', serverId, machineId: runnerId, callback: 'manual' });
    expect(startResult.expiresAt).toBeGreaterThan(Date.now());
    expect(startResult).not.toHaveProperty('oauthState');
    const startCommand = agent.messages.find(message => message.type === 'mcp.oauth.start' && message.payload.serverId === serverId)!;
    expect(startCommand.payload).toMatchObject({
      serverId,
      machineId: runnerId,
      redirectUri: OAUTH_LOOPBACK_REDIRECT_URI,
      serverUrl: 'https://oauth-mcp.example.test/mcp',
      transport: 'http',
      oauthClientId: 'pre-registered-client',
    });
    const oauthState = new URL(startResult.authorizationUrl).searchParams.get('state')!;
    const callbackCode = 'oauth-callback-code-should-not-leak';
    const complete = (machineId: string, callbackUrl: string) =>
      t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/servers/${serverId}/oauth/complete`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId, callbackUrl },
      });
    const pastedUrl = `${OAUTH_LOOPBACK_REDIRECT_URI}?code=${callbackCode}&state=${encodeURIComponent(oauthState)}`;
    expect((await complete(runnerId, 'not a link')).json()).toMatchObject({ error: 'oauth_callback_invalid' });
    const foreignPath = await complete(runnerId, `https://evil.example.test/callback?code=${callbackCode}&state=${encodeURIComponent(oauthState)}`);
    expect(foreignPath.statusCode).toBe(400);
    expect((await complete(runnerId, `${OAUTH_LOOPBACK_REDIRECT_URI}?code=${callbackCode}&state=unknown-state-value`)).statusCode).toBe(404);
    expect((await complete(randomUUID(), pastedUrl)).statusCode).toBe(404);
    expect(agent.messages.some(message => message.type === 'mcp.oauth.callback' && message.payload.flowId === startCommand.payload.flowId)).toBe(false);
    const callback = await complete(runnerId, `  ${pastedUrl}\n`);
    expect(callback.statusCode, callback.body).toBe(200);
    expect(callback.json()).toEqual({ serverId, machineId: runnerId, state: 'pending' });
    expect(callback.body).not.toContain(callbackCode);
    expect(logs.join('\n')).not.toContain(callbackCode);
    expect(logs.join('\n')).not.toContain(oauthState);
    const callbackCommand = agent.messages.find(message => message.type === 'mcp.oauth.callback' && message.payload.flowId === startCommand.payload.flowId)!;
    expect(callbackCommand.payload.callbackUrl).toContain(callbackCode);
    const accessToken = 'oauth-access-token-initial-7ab2';
    const refreshToken = 'oauth-refresh-token-initial-2bc3';
    agentSend(agent, 'mcp.oauth.token.update', {
      serverId,
      machineId: runnerId,
      flowId: startCommand.payload.flowId,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 60_000,
      oauthClientState: JSON.stringify({ authorizationServerUrl: 'https://idp.example.test', clientInformation: { client_id: 'client-opaque' } }),
    });
    const initial = await waitFor(
      () => t.tdb.pool.query<{ ciphertext: Buffer }>(`select ciphertext from mcp_oauth_tokens where user_id=$1 and server_id=$2`, [userId, serverId]).then(result => result.rows[0]),
      10_000,
    );
    expect(initial.ciphertext.toString('utf8')).not.toContain(accessToken);
    const key = tokenKey(Buffer.alloc(32, 17).toString('base64'));
    const clientState = JSON.stringify({ authorizationServerUrl: 'https://idp.example.test', clientInformation: { client_id: 'client-opaque' } });
    expect(JSON.parse(decryptToken(key, `${userId}:${serverId}`, initial.ciphertext))).toMatchObject({ accessToken, refreshToken, oauthClientState: clientState });
    const firstCiphertext = initial.ciphertext.toString('hex');
    const rotatedAccess = 'oauth-access-token-rotated-8cd4';
    const rotatedRefresh = 'oauth-refresh-token-rotated-9de5';
    agentSend(agent, 'mcp.oauth.token.update', {
      serverId,
      machineId: runnerId,
      accessToken: rotatedAccess,
      refreshToken: rotatedRefresh,
      expiresAt: Date.now() + 120_000,
    });
    const rotated = await waitFor(async () => {
      const result = await t.tdb.pool.query<{ ciphertext: Buffer }>(`select ciphertext from mcp_oauth_tokens where user_id=$1 and server_id=$2`, [userId, serverId]);
      return result.rows[0] && result.rows[0].ciphertext.toString('hex') !== firstCiphertext ? result.rows[0] : null;
    }, 10_000);
    expect(JSON.parse(decryptToken(key, `${userId}:${serverId}`, rotated.ciphertext))).toMatchObject({ accessToken: rotatedAccess, refreshToken: rotatedRefresh, oauthClientState: clientState });
    agentSend(agent, 'mcp.oauth.status.update', {
      serverId,
      machineId: runnerId,
      state: 'refresh-error',
      expiresAt: Date.now() + 120_000,
      error: `refresh failed for ${rotatedAccess}`,
    });
    const status = await waitFor(async () => {
      const response = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie } });
      const item = (response.json() as { oauth: Array<{ serverId: string; state: string; error?: string }> }).oauth.find(row => row.serverId === serverId);
      return item?.state === 'refresh-error' ? item : null;
    }, 10_000);
    expect(status.error).toContain('[REDACTED]');
    expect(logs.join('\n')).not.toContain(accessToken);
    expect(logs.join('\n')).not.toContain(rotatedAccess);
    const revoked = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/servers/${serverId}/oauth/revoke`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ serverId, machineId: runnerId, state: 'needs-login' });
    expect(agent.messages.some(message => message.type === 'mcp.oauth.revoke' && message.payload.serverId === serverId)).toBe(true);
    expect((await t.tdb.pool.query(`select 1 from mcp_oauth_tokens where user_id=$1 and server_id=$2`, [userId, serverId])).rowCount).toBe(0);
  });

  it('returns the provider to the hub callback when the server registers its client dynamically', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(`registry_oauth_dcr_${randomUUID().slice(0, 8)}`).server,
          transport: 'http',
          mode: 'remote',
          url: 'https://oauth-dcr.example.test/mcp',
          machineScope: { allMachines: false, machineIds: [runnerId] },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const started = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/servers/${serverId}/oauth/start`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId },
    });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ callback: 'hub' });
    const startCommand = agent.messages.find(message => message.type === 'mcp.oauth.start' && message.payload.serverId === serverId)!;
    expect(startCommand.payload.redirectUri).toBe(`${PUBLIC_URL}/mcp/oauth/callback`);
    expect(startCommand.payload).not.toHaveProperty('oauthClientId');
  });

  it('rejects OAuth start when the server URL contains a secret placeholder', async () => {
    const serverName = `registry_oauth_url_secret_${randomUUID().slice(0, 8)}`;
    const value = `OAUTH_URL_SECRET_${randomUUID()}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(serverName).server,
          transport: 'http',
          mode: 'remote',
          url: 'https://mcp.example.test/mcp?api_key=__AGENT_HUB_SECRET__',
          machineScope: { allMachines: false, machineIds: [runnerId] },
        },
        secrets: [{ name: 'url:api_key', value }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const before = agent.messages.filter(message => message.type === 'mcp.oauth.start').length;
    const response = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/servers/${serverId}/oauth/start`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_input' });
    expect(agent.messages.filter(message => message.type === 'mcp.oauth.start')).toHaveLength(before);
    expect(response.body).not.toContain(value);
  });

  it('never sends corporate OAuth URLs or credentials to a non-allow-listed machine', async () => {
    const otherRunnerId = randomUUID();
    const otherToken = await t.addRunner(otherRunnerId, 'mcp_oauth_unlisted_agent');
    const otherAgent = connectAgent(otherToken, { protocol: '1.13', capabilities: [...MCP_REGISTRY_CAPABILITIES] });
    autoReply(otherAgent, () => ({}));
    try {
      await otherAgent.next('welcome');
      const serverName = `registry_oauth_private_${randomUUID().slice(0, 8)}`;
      const privateUrl = 'https://corp-mcp.example.test/private-path';
      const created = await t.hub.app.inject({
        method: 'POST',
        url: '/api/mcp/registry',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: {
          server: {
            ...candidate(serverName).server,
            transport: 'http',
            mode: 'remote',
            url: privateUrl,
            machineScope: { allMachines: false, machineIds: [runnerId] },
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const serverId = (created.json() as { id: string }).id;
      await waitFor(() => otherAgent.messages.some(message => message.type === 'mcp.registry.sync'));
      for (const message of otherAgent.messages.filter(item => item.type === 'mcp.registry.sync')) {
        expect(JSON.stringify(message.payload)).not.toContain(serverName);
        expect(JSON.stringify(message.payload)).not.toContain(privateUrl);
      }
      const denied = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/servers/${serverId}/oauth/start`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: otherRunnerId },
      });
      expect(denied.statusCode).toBe(403);
      expect(otherAgent.messages.some(message => message.type === 'mcp.oauth.start' && message.payload.serverId === serverId)).toBe(false);
      expect(otherAgent.messages.some(message => JSON.stringify(message.payload).includes(privateUrl))).toBe(false);
      agentSend(otherAgent, 'mcp.oauth.token.update', {
        serverId,
        machineId: otherRunnerId,
        accessToken: 'unallowed-agent-token-value',
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      expect((await t.tdb.pool.query(`select 1 from mcp_oauth_tokens where user_id=$1 and server_id=$2`, [userId, serverId])).rowCount).toBe(0);
      expect(otherAgent.messages.some(message => message.type === 'mcp.oauth.credentials' && message.payload.serverId === serverId)).toBe(false);
    } finally {
      otherAgent.ws.close();
    }
  });

  it('keeps registry consumption off while a machine waits for its auto-import', async () => {
    const machineId = randomUUID();
    const token = await t.addRunner(machineId, 'mcp_registry_auto_pending');
    await t.tdb.pool.query(`UPDATE runners SET mcp_import_state = 'auto-pending' WHERE id = $1`, [machineId]);
    const machine = connectAgent(token, { protocol: '1.13', capabilities: [...MCP_REGISTRY_CAPABILITIES] });
    autoReply(machine, () => ({}));
    try {
      await machine.next('welcome');
      const name = `registry_auto_pending_${randomUUID().slice(0, 8)}`;
      const created = await t.hub.app.inject({
        method: 'POST',
        url: '/api/mcp/registry',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: {
          server: {
            ...candidate(name).server,
            machineScope: { allMachines: false, machineIds: [machineId] },
          },
          secrets: [{ name: 'API_KEY', value: 'MCP_AUTO_PENDING_SECRET_4f29' }],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const serverId = (created.json() as { id: string }).id;
      const disabledSync = await waitFor(() => machine.messages.find(message => message.type === 'mcp.registry.sync' && message.payload.registryEnabled === false) ?? null);
      expect(disabledSync.payload.servers).toEqual([]);
      expect(disabledSync.id).toEqual(expect.any(String));
      expect(machine.messages.some(message => message.type === 'mcp.secrets.deliver' && message.payload.serverId === serverId)).toBe(false);
    } finally {
      machine.ws.close();
    }
  });

  it('omits projectId from start when no project is resolved', async () => {
    const before = agent.messages.length;
    const started = await t.hub.app.inject({
      method: 'POST',
      url: '/api/sessions',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { runnerId, cwd: 'C:/work/none', model: 'haiku', prompt: 'hello' },
    });
    expect(started.statusCode, started.body).toBe(201);
    const command = await waitFor(() => agent.messages.slice(before).find(m => m.type === 'session.start'));
    expect(command.payload).not.toHaveProperty('projectId');
  });

  it('supports flat registry PATCH with optimistic revision and project override persistence', async () => {
    const name = `registry_patch_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: candidate(name),
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const patched = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/mcp/registry/servers/${serverId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, enabled: false, name: `${name}_renamed` },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ id: serverId, name: `${name}_renamed`, enabled: false, revision: 2 });
    const conflict = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/mcp/registry/servers/${serverId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, enabled: true },
    });
    expect(conflict.statusCode).toBe(409);
    const removed = await t.hub.app.inject({
      method: 'DELETE',
      url: `/api/mcp/registry/servers/${serverId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 2 },
    });
    expect(removed.statusCode).toBe(200);

    const overrideServer = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: candidate(`${name}_override`),
    });
    const overrideServerId = (overrideServer.json() as { id: string }).id;
    const userId = (await t.tdb.pool.query<{ id: string }>(`select id from users where email=$1`, ['alice@example.com'])).rows[0]!.id;
    const projectId = (await t.tdb.pool.query<{ id: string }>(`insert into catalog_projects(user_id,name) values($1,$2) returning id`, [userId, `override_${name}`])).rows[0]!.id;
    const override = await t.hub.app.inject({
      method: 'PUT',
      url: `/api/mcp/registry/servers/${overrideServerId}/projects/${projectId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 0, enabled: false },
    });
    expect(override.statusCode, override.body).toBe(200);
    expect(override.json()).toMatchObject({ serverId: overrideServerId, projectId, enabled: false, revision: 1 });
    const sync = await waitFor(() =>
      agent.messages.find(
        m =>
          m.type === 'mcp.registry.sync' &&
          (m.payload.projectOverrides as unknown[])?.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify({ projectId, serverId: overrideServerId, enabled: false })),
      ),
    );
    expect(sync.payload.projectOverrides).toContainEqual({ projectId, serverId: overrideServerId, enabled: false });
    const read = await t.hub.app.inject({
      method: 'GET',
      url: `/api/mcp/registry/servers/${overrideServerId}/projects/${projectId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
    });
    expect(read.json()).toMatchObject({ enabled: false, revision: 1 });
    const revisionConflict = await t.hub.app.inject({
      method: 'PUT',
      url: `/api/mcp/registry/servers/${overrideServerId}/projects/${projectId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 0, enabled: true },
    });
    expect(revisionConflict.statusCode).toBe(409);
  });

  it('rejects an empty machine scope on REST create and patch', async () => {
    const invalidPost = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: { ...candidate(`registry_empty_scope_post_${randomUUID().slice(0, 6)}`).server, machineScope: { allMachines: false, machineIds: [] } } },
    });
    expect(invalidPost.statusCode).toBe(400);
    expect(invalidPost.json().message).toContain('include at least one machine when allMachines is false');

    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(`registry_empty_scope_patch_${randomUUID().slice(0, 6)}`).server },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const patched = await t.hub.app.inject({
      method: 'PATCH',
      url: `/api/mcp/registry/servers/${serverId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, machineScope: { allMachines: false, machineIds: [] } },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().message).toContain('include at least one machine when allMachines is false');
  });

  it('reads and syncs a legacy persisted server with an empty machine scope', async () => {
    const name = `registry_legacy_scope_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(name).server },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    await t.tdb.pool.query(`UPDATE mcp_registry_servers SET config=jsonb_set(config, '{machineScope}', $3::jsonb) WHERE user_id=$1 AND id=$2`, [
      userId,
      serverId,
      JSON.stringify({ allMachines: false, machineIds: [] }),
    ]);

    const listed = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry', cookies: { ah_session: cookie } });
    expect(listed.statusCode, listed.body).toBe(200);
    const legacyEntry = (listed.json() as { servers: Array<Record<string, unknown>> }).servers.find(server => server.id === serverId);
    expect(legacyEntry).toMatchObject({ id: serverId, machineScope: { allMachines: false, machineIds: [] } });

    const syncBefore = agent.messages.filter(message => message.type === 'mcp.registry.sync').length;
    const trigger = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: candidate(`registry_legacy_trigger_${randomUUID().slice(0, 8)}`).server },
    });
    expect(trigger.statusCode, trigger.body).toBe(201);
    await waitFor(() => agent.messages.filter(message => message.type === 'mcp.registry.sync').length > syncBefore);
    expect(agent.messages.filter(message => message.type === 'mcp.registry.sync').at(-1)?.payload.servers).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: serverId })]));
  });

  it('stores gateway status from a runner with a non-GUID machine id', async () => {
    const name = `registry_gateway_status_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: { ...candidate(name).server, machineScope: { allMachines: false, machineIds: [runnerId] } } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const observedAt = Date.now();
    const beforeLogs = logs.length;
    agentSend(agent, 'mcp.gateway.status', {
      serverId,
      machineId: runnerId,
      status: 'ready',
      endpoint: 'http://127.0.0.1:8765/mcp',
      observedAt: observedAt + 86_400_000,
    });
    const status = await waitFor(async () => {
      const response = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie } });
      const gateway = (response.json() as { gateways: Array<Record<string, unknown>> }).gateways.find(row => row.serverId === serverId);
      return gateway ?? null;
    });
    expect(status).toMatchObject({ serverId, machineId: 'vm', status: 'ready', endpoint: 'http://127.0.0.1:8765/mcp' });
    const stored = await t.tdb.pool.query(`select id from mcp_gateway_statuses where server_id=$1 and machine_id=$2`, [serverId, runnerId]);
    expect(stored.rowCount).toBe(1);
    const observed = await t.tdb.pool.query<{ observed_at: Date }>(`select observed_at from mcp_gateway_statuses where server_id=$1 and machine_id=$2`, [serverId, runnerId]);
    expect(observed.rows[0]!.observed_at.getTime()).toBeLessThan(Date.now() + 31_000);
    expect(logs.slice(beforeLogs).join('\n')).not.toContain('MCP gateway status update rejected');
  });

  it('gates connection checks for protocol 1.12 agents', async () => {
    const oldRunnerId = randomUUID();
    const oldToken = await t.addRunner(oldRunnerId, 'mcp_old_agent');
    const oldAgent = connectAgent(oldToken, { protocol: '1.12', capabilities: [] });
    try {
      await oldAgent.next('welcome');
      const status = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
      const agents = (status.json() as { agents: Array<Record<string, unknown>> }).agents;
      expect(agents.find(runner => runner.machineId === oldRunnerId)).toMatchObject({ protocolVersion: '1.12', online: true, capabilities: [] });
      const userId = (await t.tdb.pool.query<{ id: string }>(`select id from users where email=$1`, ['alice@example.com'])).rows[0]!.id;
      await t.tdb.pool.query(`insert into project_bindings(user_id,project_id,runner_id,path) values($1,$2,$3,$4)`, [userId, catalogProjectId, oldRunnerId, 'C:/work/old']);
      autoReply(oldAgent, type => (type === 'fs.stat' ? { exists: true, isDir: true } : type === 'session.start' ? { models: [] } : {}));
      const oldSession = await t.hub.app.inject({
        method: 'POST',
        url: '/api/sessions',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { runnerId: oldRunnerId, cwd: 'C:/work/old', model: 'haiku', prompt: 'hello', projectId: catalogProjectId },
      });
      expect(oldSession.statusCode, oldSession.body).toBe(201);
      const start = await waitFor(() => oldAgent.messages.find(m => m.type === 'session.start'));
      expect(start.payload).not.toHaveProperty('projectId');
      const created = await t.hub.app.inject({
        method: 'POST',
        url: '/api/mcp/registry/drafts',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: candidate(`registry_old_agent_${randomUUID().slice(0, 8)}`),
      });
      const draft = created.json() as { draftId: string; revision: number };
      const response = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: oldRunnerId, revision: draft.revision },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'agent_outdated' });
    } finally {
      oldAgent.ws.close();
    }
  });

  it('delivers decrypted secrets only to the allow-listed target agent', async () => {
    const otherRunnerId = randomUUID();
    const otherToken = await t.addRunner(otherRunnerId, 'mcp_other_agent');
    const otherAgent = connectAgent(otherToken, { protocol: '1.13', capabilities: [...MCP_REGISTRY_CAPABILITIES] });
    const secretValue = 'MCP_TARGET_ONLY_SECRET_1c5e';
    try {
      await otherAgent.next('welcome');
      const created = await t.hub.app.inject({
        method: 'POST',
        url: '/api/mcp/registry',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: {
          server: {
            ...candidate(`registry_target_secret_${randomUUID().slice(0, 6)}`).server,
            machineScope: { allMachines: false, machineIds: [runnerId] },
          },
          secrets: [{ name: 'API_TOKEN', value: secretValue }],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      await waitFor(() => agent.messages.find(m => m.type === 'mcp.secrets.deliver' && (m.payload.secrets as Array<{ value: string }>)[0]?.value === secretValue));
      expect(otherAgent.messages.some(m => m.type === 'mcp.secrets.deliver' && JSON.stringify(m.payload).includes(secretValue))).toBe(false);
      expect(created.body).not.toContain(secretValue);
      expect(logs.join('\n')).not.toContain(secretValue);
    } finally {
      otherAgent.ws.close();
    }
  });

  it('creates one draft, reports name_taken, and never returns or logs plaintext secrets', async () => {
    const body = { ...candidate('registry_secret_probe'), secrets: [{ name: 'API_TOKEN', value: secret }] };
    const added = await request('add', body);
    expect(added.payload, JSON.stringify({ payload: added.payload, logs })).toMatchObject({
      ok: true,
      result: { draft: { state: 'checked' }, validation: { ok: true, status: 'checked' } },
    });
    expect(JSON.stringify(added.payload)).not.toContain(secret);
    const duplicate = await request('add', body);
    expect(duplicate.payload).toMatchObject({ ok: false, error: { code: 'name_taken' } });
    const draftId = (added.payload as { result: { draft: { draftId: string } } }).result.draft.draftId;
    const registryView = await t.hub.app.inject({
      method: 'GET',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
    });
    expect(registryView.statusCode).toBe(200);
    expect(registryView.json()).toMatchObject({ drafts: expect.arrayContaining([expect.objectContaining({ draftId })]) });
    const updated = await request('update', { draftId, update: { revision: 1, server: { command: 'node --version' } } });
    expect(updated.payload).toMatchObject({
      ok: true,
      result: { draft: { draftId, revision: 2, state: 'checked', server: { name: 'registry_secret_probe', command: 'node --version' } } },
    });
    expect(JSON.stringify(updated.payload)).not.toContain(secret);
    const stored = (await t.tdb.pool.query<{ ciphertext: Buffer }>(`select ciphertext from mcp_secrets where name='API_TOKEN'`)).rows[0];
    expect(stored).toBeDefined();
    expect(stored!.ciphertext.includes(Buffer.from(secret))).toBe(false);
    const audit = await t.tdb.pool.query<{ details: unknown }>(`select details from mcp_registry_audit`);
    expect(JSON.stringify(audit.rows)).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('returns check results and the confirmation link as part of mcp_add', async () => {
    const name = `registry_tool_check_${randomUUID().slice(0, 8)}`;
    validationResult = { ok: true, status: 'checked', tools: [{ name: 'qa.echo' }], oauthRequired: false };
    let added;
    try {
      added = await request('add', candidate(name));
    } finally {
      validationResult = null;
    }
    expect(added.payload).toMatchObject({
      ok: true,
      result: {
        draftId: expect.any(String),
        validation: { ok: true, status: 'checked', tools: [{ name: 'qa.echo' }] },
        confirmationUrl: `/s/${sessionId}?mcp=1`,
      },
    });
  });

  it('binds a session-opened UI draft to its owning live session', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { ...candidate(`registry_ui_session_${randomUUID().slice(0, 8)}`), sessionId },
    });
    expect(created.statusCode, created.body).toBe(201);
    const draftId = created.json().draftId as string;
    const checked = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId, revision: 1 },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const connected = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(agent.messages.filter(message => message.type === 'mcp.registry.session-update').at(-1)?.payload).toMatchObject({ sessionId });

    const foreign = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { ...candidate(`registry_foreign_session_${randomUUID().slice(0, 8)}`), sessionId: randomUUID() },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('bounds untrusted tools returned to mcp_add', async () => {
    validationResult = {
      ok: true,
      status: 'checked',
      tools: Array.from({ length: 101 }, (_, index) => ({ name: `tool-${index}`, description: 'd'.repeat(250) })),
      oauthRequired: false,
    };
    let added;
    try {
      added = await request('add', candidate(`registry_tool_bounded_${randomUUID().slice(0, 8)}`));
    } finally {
      validationResult = null;
    }
    const validation = (added.payload as { result: { validation: { tools: Array<{ description?: string }>; truncated?: boolean } } }).result.validation;
    expect(validation.tools).toHaveLength(100);
    expect(validation.tools[0]?.description).toHaveLength(200);
    expect(validation.truncated).toBe(true);
  });

  it('returns safe validation failure, timeout, and needs-secret results from mcp_add', async () => {
    const needsSecret = await request('add', {
      server: {
        ...candidate(`registry_tool_missing_secret_${randomUUID().slice(0, 8)}`).server,
        env: { API_TOKEN: { kind: 'secret-name', name: 'API_TOKEN' } },
      },
    });
    expect(needsSecret.payload).toMatchObject({
      ok: true,
      result: { draftId: expect.any(String), validation: { ok: false, status: 'needs-secret', tools: [] }, confirmationUrl: expect.any(String) },
    });
    const missingDraftId = (needsSecret.payload as { result: { draftId: string } }).result.draftId;
    const supplied = await request('update', {
      draftId: missingDraftId,
      update: {
        revision: 1,
        server: {},
        secrets: [{ name: 'API_TOKEN', value: `LATER_${randomUUID()}` }],
      },
    });
    expect(supplied.payload).toMatchObject({
      ok: true,
      result: { validation: { ok: true, status: 'checked' } },
    });
    const resolvedDraft = await t.hub.app.inject({
      method: 'GET',
      url: `/api/mcp/registry/drafts/${missingDraftId}`,
      cookies: { ah_session: cookie },
    });
    expect(resolvedDraft.json().server.secrets).toHaveLength(1);
    expect(resolvedDraft.json().server.secrets[0].state).toBe('set');

    validationResult = { ok: false, status: 'validation-failed', error: 'Safe command failure', tools: [], oauthRequired: false };
    try {
      const failed = await request('add', candidate(`registry_tool_failed_${randomUUID().slice(0, 8)}`));
      expect(failed.payload).toMatchObject({ ok: true, result: { validation: { ok: false, status: 'validation-failed', error: 'Safe command failure' } } });
    } finally {
      validationResult = null;
    }

    validationHold = () => undefined;
    try {
      const timedOut = await request('add', candidate(`registry_tool_timeout_${randomUUID().slice(0, 8)}`));
      expect(timedOut.payload).toMatchObject({ ok: true, result: { validation: { ok: false, status: 'timeout', error: 'Connection check timed out.' } } });
    } finally {
      validationHold = null;
      validationStarted = false;
    }
  });

  it('filters tool names that exceed the validation result schema limit', async () => {
    const originalValidate = t.hub.mcpRegistry.validate.bind(t.hub.mcpRegistry);
    // A partial result is enough: the route only reads the state and the validation.
    t.hub.mcpRegistry.validate = (async () => ({
      state: 'checked',
      validation: {
        ok: true,
        status: 'checked',
        tools: [{ name: 't'.repeat(129) }, { name: 'valid_tool' }],
        oauthRequired: false,
      },
    })) as unknown as typeof originalValidate;
    try {
      const response = await request('add', { server: candidate(`registry_long_tool_name_${randomUUID().slice(0, 8)}`).server });
      expect(response.payload).toMatchObject({ ok: true, result: { validation: { tools: [{ name: 'valid_tool' }], truncated: true } } });
      expect(JSON.stringify(response.payload)).not.toContain('t'.repeat(129));
    } finally {
      t.hub.mcpRegistry.validate = originalValidate;
    }
  });

  it('keeps existing server edits as revision-bound drafts until UI confirmation', async () => {
    const name = `registry_tool_update_${randomUUID().slice(0, 8)}`;
    const originalSecret = `ORIGINAL_${randomUUID()}`;
    const replacementSecret = `REPLACED_${randomUUID()}`;
    const base = candidate(name);
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        ...base,
        server: { ...base.server, env: { API_TOKEN: { kind: 'secret-name', name: 'API_TOKEN' } } },
        secrets: [{ name: 'API_TOKEN', value: originalSecret }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = created.json().id as string;
    const originalRef = created.json().env.API_TOKEN.secretId as string;
    const edited = await request('update', {
      serverId,
      update: {
        revision: 1,
        server: { command: 'node --version' },
        secrets: [{ name: 'API_TOKEN', value: replacementSecret }],
      },
    });
    expect(edited.payload).toMatchObject({
      ok: true,
      result: {
        draftId: expect.any(String),
        validation: { ok: true, status: 'checked' },
        confirmationUrl: `/s/${sessionId}?mcp=1`,
      },
    });
    const draftId = (edited.payload as { result: { draftId: string } }).result.draftId;
    const unchecked = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/save-unchecked`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(unchecked.statusCode).toBe(409);
    expect(unchecked.json()).toMatchObject({
      error: 'validation_required',
      message: 'Connected MCP updates must pass validation before confirmation',
    });
    const validationCommand = agent.messages.filter(message => message.type === 'mcp.registry.validate').at(-1);
    expect(validationCommand?.payload).toMatchObject({ secretDelivery: { secrets: [{ name: 'API_TOKEN', value: replacementSecret }] } });
    expect((validationCommand?.payload as { server: { id: string } } | undefined)?.server.id).toBe(draftId);
    const unchanged = await t.hub.app.inject({ method: 'GET', url: `/api/mcp/registry/servers/${serverId}`, cookies: { ah_session: cookie } });
    expect(unchanged.json()).toMatchObject({ revision: 1, command: 'node' });
    expect(unchanged.json().env.API_TOKEN.secretId).toBe(originalRef);
    const confirmed = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ serverId, state: 'connected', server: { id: serverId, revision: 2, command: 'node --version' } });
    expect(confirmed.json().server.env.API_TOKEN.secretId).not.toBe(originalRef);
    const stored = await t.tdb.pool.query<{ id: string; ciphertext: Buffer }>(`select id,ciphertext from mcp_secrets where server_id=$1 and name='API_TOKEN'`, [serverId]);
    expect(stored.rows).toHaveLength(1);
    const key = tokenKey(Buffer.alloc(32, 17).toString('base64'));
    expect(decryptToken(key, `${userId}:${stored.rows[0]!.id}`, stored.rows[0]!.ciphertext)).toBe(replacementSecret);
  });

  it('sends an OAuth server id only when an existing server draft keeps its origin and transport', async () => {
    const createHttpServer = async (name: string) => {
      const created = await t.hub.app.inject({
        method: 'POST',
        url: '/api/mcp/registry',
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: {
          server: {
            ...candidate(name).server,
            transport: 'http',
            mode: 'remote',
            url: 'https://trusted-mcp.example.test/mcp',
            machineScope: { allMachines: false, machineIds: [runnerId] },
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      return (created.json() as { id: string }).id;
    };

    const changedOriginServerId = await createHttpServer(`registry_oauth_origin_change_${randomUUID().slice(0, 8)}`);
    const changedOriginBefore = agent.messages.length;
    const changedOrigin = await request('update', {
      serverId: changedOriginServerId,
      update: { revision: 1, server: { url: 'https://attacker.example/mcp' } },
    });
    expect(changedOrigin.payload).toMatchObject({ ok: true });
    const changedOriginValidation = agent.messages.slice(changedOriginBefore).find(message => message.type === 'mcp.registry.validate' && message.payload.draftId !== changedOriginServerId);
    expect(changedOriginValidation?.payload).not.toHaveProperty('oauthServerId');

    const sameOriginServerId = await createHttpServer(`registry_oauth_origin_same_${randomUUID().slice(0, 8)}`);
    const sameOriginBefore = agent.messages.length;
    const sameOrigin = await request('update', {
      serverId: sameOriginServerId,
      update: { revision: 1, server: { url: 'https://trusted-mcp.example.test/other-path' } },
    });
    expect(sameOrigin.payload).toMatchObject({ ok: true });
    const sameOriginValidation = agent.messages.slice(sameOriginBefore).find(message => message.type === 'mcp.registry.validate' && message.payload.draftId !== sameOriginServerId);
    expect(sameOriginValidation?.payload).toMatchObject({ oauthServerId: sameOriginServerId });
  });

  it('maps a rejected dynamic client registration to its own code and keeps the old agent code generic', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(`registry_oauth_dcr_rejected_${randomUUID().slice(0, 8)}`).server,
          transport: 'http',
          mode: 'remote',
          url: 'https://oauth-dcr-rejected.example.test/mcp',
          machineScope: { allMachines: false, machineIds: [runnerId] },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const start = () =>
      t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/servers/${serverId}/oauth/start`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: runnerId },
      });
    const oauthStatus = async () => {
      const response = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie } });
      return (response.json() as { oauth: Array<{ serverId: string; state: string; error?: string }> }).oauth.find(row => row.serverId === serverId);
    };
    try {
      oauthStartFailureCode = 'oauth_registration_rejected';
      const rejected = await start();
      expect(rejected.statusCode).toBe(502);
      expect(rejected.json()).toMatchObject({ error: 'oauth_registration_rejected' });
      expect(rejected.body).not.toContain('UNSAFE_AUTH_SERVER_BODY');
      expect(await oauthStatus()).toMatchObject({ state: 'failed', error: expect.stringContaining('pre-registered OAuth client id') });

      oauthStartFailureCode = 'oauth_start_failed';
      const generic = await start();
      expect(generic.statusCode).toBe(502);
      expect(generic.json()).toMatchObject({ error: 'oauth_start_failed' });
      expect(generic.body).not.toContain('UNSAFE_AUTH_SERVER_BODY');
    } finally {
      oauthStartFailureCode = null;
    }
    expect(JSON.stringify(await oauthStatus())).not.toContain('UNSAFE_AUTH_SERVER_BODY');
    expect(logs.join('\n')).not.toContain('UNSAFE_AUTH_SERVER_BODY');
  });

  it('confirms an existing server edit that needs sign-in as needs-login without a session update', async () => {
    const name = `registry_update_needs_auth_${randomUUID().slice(0, 8)}`;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(name).server,
          transport: 'http',
          mode: 'remote',
          url: 'https://update-needs-auth.example.test/mcp',
          machineScope: { allMachines: false, machineIds: [runnerId] },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    validationResult = { ok: false, status: 'needs_auth', tools: [], oauthRequired: true };
    let draftId: string;
    try {
      const edited = await request('update', { serverId, update: { revision: 1, server: { oauthClientId: 'pre-registered-client' } } });
      expect(edited.payload).toMatchObject({ ok: true, result: { validation: { status: 'needs_auth' } } });
      draftId = (edited.payload as { result: { draftId: string } }).result.draftId;
    } finally {
      validationResult = null;
    }
    const before = agent.messages.length;
    const confirmed = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ serverId, state: 'needs-login', server: { id: serverId, revision: 2, oauthClientId: 'pre-registered-client' } });
    const statusResponse = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie } });
    expect(statusResponse.json()).toMatchObject({ oauth: expect.arrayContaining([expect.objectContaining({ serverId, machineId: runnerId, state: 'needs-login', connected: false })]) });
    const sync = await waitFor(
      () =>
        agent.messages
          .slice(before)
          .filter(message => message.type === 'mcp.registry.sync')
          .at(-1) ?? null,
    );
    expect(sync.payload.servers).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: serverId })]));
    expect(agent.messages.slice(before).some(message => message.type === 'mcp.registry.session-update' && (message.payload.server as { id?: string } | undefined)?.id === serverId)).toBe(false);
  });

  it('resets OAuth tokens only when the client id or URL origin changes and clears the client id with null', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate(`registry_oauth_reset_${randomUUID().slice(0, 8)}`).server,
          transport: 'http',
          mode: 'remote',
          url: 'https://oauth-reset.example.test/mcp',
          oauthClientId: 'client-a',
          machineScope: { allMachines: false, machineIds: [runnerId] },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = (created.json() as { id: string }).id;
    const tokenCount = () => t.tdb.pool.query(`select 1 from mcp_oauth_tokens where user_id=$1 and server_id=$2`, [userId, serverId]).then(result => result.rowCount ?? 0);
    const signIn = async (accessToken: string) => {
      agentSend(agent, 'mcp.oauth.token.update', { serverId, machineId: runnerId, accessToken });
      await waitFor(tokenCount);
    };
    const patch = (payload: Record<string, unknown>) =>
      t.hub.app.inject({ method: 'PATCH', url: `/api/mcp/registry/servers/${serverId}`, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload });
    const revokes = () => agent.messages.filter(message => message.type === 'mcp.oauth.revoke' && message.payload.serverId === serverId).length;

    await signIn('oauth-reset-access-1');
    const renamed = await patch({ revision: 1, name: `registry_oauth_reset_renamed_${randomUUID().slice(0, 8)}`, url: 'https://oauth-reset.example.test/other' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await tokenCount()).toBe(1);
    expect(revokes()).toBe(0);

    const changedClient = await patch({ revision: 2, oauthClientId: 'client-b' });
    expect(changedClient.statusCode, changedClient.body).toBe(200);
    expect(changedClient.json()).toMatchObject({ oauthClientId: 'client-b' });
    expect(await tokenCount()).toBe(0);
    await waitFor(() => revokes() === 1);
    const statusResponse = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie } });
    expect(statusResponse.json()).toMatchObject({ oauth: expect.arrayContaining([expect.objectContaining({ serverId, machineId: runnerId, state: 'needs-login' })]) });

    await signIn('oauth-reset-access-2');
    const changedOrigin = await patch({ revision: 3, url: 'https://oauth-reset-other.example.test/mcp' });
    expect(changedOrigin.statusCode, changedOrigin.body).toBe(200);
    expect(await tokenCount()).toBe(0);

    const cleared = await patch({ revision: 4, oauthClientId: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).not.toHaveProperty('oauthClientId');
    const stored = await t.hub.app.inject({ method: 'GET', url: `/api/mcp/registry/servers/${serverId}`, cookies: { ah_session: cookie } });
    expect(stored.json()).not.toHaveProperty('oauthClientId');
  });

  it('returns only owner-visible drafts from mcp_list', async () => {
    const r = await request('list', { includeDrafts: true });
    expect(r.payload).toMatchObject({
      ok: true,
      result: {
        drafts: expect.arrayContaining([expect.objectContaining({ server: expect.objectContaining({ name: 'registry_secret_probe' }) })]),
      },
    });
    expect(JSON.stringify(r.payload)).not.toContain(secret);
  });

  it('rejects a secret reference that is not owned by the draft', async () => {
    const secretId = randomUUID();
    const body = { server: { ...candidate('registry_needs_secret').server, env: { API_TOKEN: { kind: 'secret', secretId } } } };
    const created = await t.hub.app.inject({ method: 'POST', url: '/api/mcp/registry/drafts', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL }, payload: body });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({ error: 'invalid_input' });
  });

  it('saves URL query secrets as placeholders and ciphertext', async () => {
    const value = 'MCP_URL_SECRET_8d21';
    const base = candidate('registry_url_secret');
    const response = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: { ...base.server, transport: 'http', command: undefined, url: 'https://mcp.example.test/mcp?api_key=__AGENT_HUB_SECRET__' },
        secrets: [
          { name: 'url:api_key', value },
          { name: 'url:username', value: `${value}_user` },
          { name: 'url:password', value: `${value}_password` },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.body).not.toContain(value);
    expect(response.json()).toMatchObject({ server: { url: 'https://__AGENT_HUB_SECRET__:__AGENT_HUB_SECRET__@mcp.example.test/mcp?api_key=__AGENT_HUB_SECRET__' } });
    const stored = (await t.tdb.pool.query<{ ciphertext: Buffer; name: string }>(`select ciphertext,name from mcp_secrets where name like 'url:%'`)).rows;
    expect(stored.map(row => row.name)).toEqual(expect.arrayContaining(['url:api_key', 'url:username', 'url:password']));
    expect(stored.every(row => !row.ciphertext.includes(Buffer.from(value)))).toBe(true);
  });

  it('rejects direct registry writes that contain unreferenced URL credentials', async () => {
    const password = 'MCP_RAW_URL_PASSWORD_298f';
    const response = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: {
        server: {
          ...candidate('registry_raw_url_credential').server,
          transport: 'http',
          command: undefined,
          url: `https://user:${password}@mcp.example.test/mcp`,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(password);
    const saved = await t.tdb.pool.query(`select id from mcp_registry_servers where name='registry_raw_url_credential'`);
    expect(saved.rows).toHaveLength(0);
  });

  it('stores session activation acknowledgements and exposes their result in registry status', async () => {
    const base = { ...candidate('registry_live_activation'), secrets: [{ name: 'API_TOKEN', value: secret }] };
    const added = await request('add', base);
    expect(added.payload).toMatchObject({ ok: true, result: { draft: { draftId: expect.any(String) } } });
    const draftId = (added.payload as { result: { draft: { draftId: string } } }).result.draft.draftId;
    const validation = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId: runnerId, revision: 1 },
    });
    expect(validation.statusCode, validation.body).toBe(200);
    const updateStart = agent.messages.length;
    const connected = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draftId}/connect`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { revision: 1, userConfirmed: true },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({ sessionUpdate: { activation: 'pending', applied: false } });
    const update = await waitFor(() => agent.messages.slice(updateStart).find(message => message.type === 'mcp.registry.session-update') ?? null, 15_000);
    agentSend(agent, 'mcp.registry.session-update.ack', {
      sessionId,
      revision: update.payload.revision,
      activation: 'available-next-thread',
      applied: true,
      error: secret,
    });
    await waitFor(async () => {
      const status = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
      return (
        (status.json() as { sessionUpdates?: Array<Record<string, unknown>> }).sessionUpdates?.find(
          x => x.serverId === (connected.json() as { serverId: string }).serverId && x.activation === 'available-next-thread',
        ) ?? null
      );
    }, 15_000);
    const status = await t.hub.app.inject({ method: 'GET', url: '/api/mcp/registry/status', cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
    expect((status.json() as { sessionUpdates: Array<Record<string, unknown>> }).sessionUpdates).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId, activation: 'available-next-thread', applied: true, error: '[REDACTED]' })]),
    );
    expect(status.body).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
    const updatedDraft = await t.hub.app.inject({
      method: 'GET',
      url: `/api/mcp/registry/drafts/${draftId}`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
    });
    expect(updatedDraft.json()).toMatchObject({ sessionUpdate: { activation: 'available-next-thread', applied: true } });
  });

  it('records a failed draft check and returns a typed timeout when the agent check times out', async () => {
    const beforeLogs = logs.length;
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: candidate('registry_validation_timeout'),
    });
    const draft = created.json() as { draftId: string; revision: number };
    validationFailureCode = 'timeout';
    try {
      const response = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: runnerId, revision: draft.revision },
      });
      expect(response.statusCode).toBe(504);
      expect(response.json()).toMatchObject({ error: 'timeout' });
      await waitFor(() => logs.slice(beforeLogs).join('\n').includes('MCP registry validation failed'));
      expect(logs.slice(beforeLogs).join('\n')).toContain('"errorCode":"timeout"');
      expect(logs.slice(beforeLogs).join('\n')).not.toContain('UNSAFE_DIAGNOSTIC_VALUE');
      const stored = await t.hub.app.inject({ method: 'GET', url: `/api/mcp/registry/drafts/${draft.draftId}`, cookies: { ah_session: cookie }, headers: { origin: PUBLIC_URL } });
      expect(stored.json()).toMatchObject({ state: 'validation-failed', validation: { ok: false, error: 'Connection check timed out' } });
    } finally {
      validationFailureCode = null;
    }
  });

  it('returns 504 and removes the waiter when an agent acknowledges without a validation result', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: candidate(`registry_result_missing_${randomUUID().slice(0, 8)}`),
    });
    const draft = created.json() as { draftId: string; revision: number };
    separateValidationResult = true;
    validationResultAbsent = true;
    try {
      const response = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: runnerId, revision: draft.revision },
      });
      expect(response.statusCode).toBe(504);
      const waiters = (t.hub.mcpRegistry as unknown as { pendingValidationResults: Map<string, unknown> }).pendingValidationResults;
      expect(waiters.size).toBe(0);
    } finally {
      separateValidationResult = false;
      validationResultAbsent = false;
    }
  });

  it('clears a validation waiter when the target agent disconnects after acknowledging', async () => {
    const machineId = randomUUID();
    const token = await t.addRunner(machineId, 'mcp_validation_disconnect');
    const disconnectedAgent = connectAgent(token, { protocol: '1.13', capabilities: [...MCP_REGISTRY_CAPABILITIES] });
    autoReply(disconnectedAgent, type => {
      if (type === 'mcp.registry.validate') {
        setTimeout(() => disconnectedAgent.ws.close(), 25);
        return { resultSent: true };
      }
      return {};
    });
    await disconnectedAgent.next('welcome');
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: { ...candidate(`registry_disconnect_${randomUUID().slice(0, 8)}`).server, machineScope: { allMachines: false, machineIds: [machineId] } } },
    });
    const draft = created.json() as { draftId: string; revision: number };
    const response = await t.hub.app.inject({
      method: 'POST',
      url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { machineId, revision: draft.revision },
    });
    expect(response.statusCode).toBe(502);
    await disconnectedAgent.closed;
    const waiters = (t.hub.mcpRegistry as unknown as { pendingValidationResults: Map<string, unknown> }).pendingValidationResults;
    expect(waiters.size).toBe(0);
  });

  it('records an invalid command result without marking the draft checked', async () => {
    const created = await t.hub.app.inject({
      method: 'POST',
      url: '/api/mcp/registry/drafts',
      cookies: { ah_session: cookie },
      headers: { origin: PUBLIC_URL },
      payload: { server: { ...candidate('registry_invalid_command').server, command: 'missing_mcp_executable_9f3' } },
    });
    const draft = created.json() as { draftId: string; revision: number };
    validationResult = { ok: false, status: 'validation-failed', error: 'Command was not found' };
    try {
      const response = await t.hub.app.inject({
        method: 'POST',
        url: `/api/mcp/registry/drafts/${draft.draftId}/validate`,
        cookies: { ah_session: cookie },
        headers: { origin: PUBLIC_URL },
        payload: { machineId: runnerId, revision: draft.revision },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: 'validation-failed', validation: { ok: false, error: 'Command was not found' } });
    } finally {
      validationResult = null;
    }
  });
});
