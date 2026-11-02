import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './cliCommands.js';
import { createTestDb, type TestDb } from './test/db.js';
import { addRunner, issueRunnerToken } from './runners/repo.js';
import { upsertUser } from './auth/sessions.js';

describe('hub CLI (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    const ivan = await upsertUser(t.db, 'jonasasx@gmail.com');
    const bob = await upsertUser(t.db, 'bob@example.com');
    await addRunner(t.db, { id: 'vm', userId: ivan.id, name: 'ВМ .3', os: 'Ubuntu 24.04' });
    await issueRunnerToken(t.db, 'vm');
    await addRunner(t.db, { id: 'hp', userId: ivan.id, name: 'HP' });
    await addRunner(t.db, { id: 'r-bob0001', userId: bob.id, name: 'Ноутбук' });
  });
  afterAll(async () => t.drop());

  const run = async (argv: string[]) => {
    const out: string[] = [];
    const code = await runCli(argv, t.db, s => out.push(s), { OIDC_ALLOWED_EMAILS: 'jonasasx@gmail.com' });
    return { code, out };
  };

  // Change multi-user (spec runner-enrollment «Машины Ивана на том же потоке»): machines come from enrollment codes.
  it('runner:add and runner:token are gone (usage, exit 2) and not in the usage text', async () => {
    const add = await run(['runner:add', 'x', '--name', 'X']);
    expect(add.code).toBe(2);
    expect(add.out.join('\n')).not.toMatch(/runner:add|runner:token/);
    expect((await run(['runner:token', 'vm'])).code).toBe(2);
  });

  it('runner:list shows the owner and the state, without token values', async () => {
    const r = await run(['runner:list']);
    const text = r.out.join('\n');
    expect(text).toMatch(/^vm\tВМ \.3\tjonasasx@gmail\.com\tactive\tmachine\t-\toffline/m);
    expect(text).toMatch(/^r-bob0001\tНоутбук\tbob@example\.com\tactive/m);
    expect(text).toContain('\ttoken');
  });

  it('runner:set-hostname: the same hostname at different owners is allowed, twice at one owner is not (design M3)', async () => {
    expect((await run(['runner:set-hostname', 'hp', 'HP-Elitebook'])).code).toBe(0);
    expect((await run(['runner:set-hostname', 'r-bob0001', 'HP-Elitebook'])).code).toBe(0);
    const dup = await run(['runner:set-hostname', 'vm', 'hp-elitebook']);
    expect(dup.code).toBe(1);
    expect(dup.out[0]).toBe('hostname hp-elitebook already belongs to runner hp');
    expect((await run(['runner:set-hostname', 'missing', 'x'])).code).toBe(1);
  });

  it('usage errors exit with 2', async () => {
    expect((await run(['runner:set-hostname', 'x'])).code).toBe(2);
    expect((await run(['nope'])).code).toBe(2);
  });
});
