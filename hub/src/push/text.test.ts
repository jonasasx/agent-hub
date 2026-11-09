import { describe, expect, it } from 'vitest';
import { PUSH_BODY_MAX } from '@agent-hub/shared';
import { tr } from '../i18n.js';
import { composeBody, failureText, permissionText, snippet, titleOf, turnText } from './text.js';

const ru = (k: string, p?: Record<string, string | number>) => tr('ru').text(k, p);
const en = (k: string, p?: Record<string, string | number>) => tr('en').text(k, p);

describe('snippet', () => {
  it('cuts secrets, fences and markdown markers and collapses spaces', () => {
    const text = '## Готово\n\n```bash\ncurl -H "Authorization: Bearer abc.def.ghi" x\n```\n**Итог**:   token=sk-ant-oat01-secretsecret';
    const s = snippet(text, 500, 'head');
    expect(s).not.toContain('abc.def.ghi');
    expect(s).not.toContain('sk-ant-oat01-secretsecret');
    expect(s).not.toMatch(/[`#]|\n|\s{2}/);
    expect(s).toContain('Готово');
  });

  it('takes the head or the tail with an ellipsis within max', () => {
    const text = `${'a'.repeat(50)}${'b'.repeat(50)}`;
    expect(snippet(text, 20, 'head')).toBe(`${'a'.repeat(19)}…`);
    expect(snippet(text, 20, 'tail')).toBe(`…${'b'.repeat(19)}`);
    expect(snippet('short', 20, 'tail')).toBe('short');
    expect(snippet('', 20, 'head')).toBe('');
  });
});

describe('snippet redaction of credentials', () => {
  it.each([
    ['mysql --password hunter2 -e x', 'hunter2'],
    ['tool --token abc123xyz run', 'abc123xyz'],
    ['tool --api-key=k-98765 run', 'k-98765'],
    ['tool --secret "s3cr3tvalue"', 's3cr3tvalue'],
    ['tool --key AbCd1234', 'AbCd1234'],
    ['curl -u admin:p4ssw0rd https://example.com', 'p4ssw0rd'],
    ['curl --user admin:p4ssw0rd https://example.com', 'p4ssw0rd'],
    ['Authorization: Bearer abc.def.ghi', 'abc.def.ghi'],
    ['authorization: token ghx12345', 'ghx12345'],
    ['"Authorization": "Basic dXNlcjpwYXNz"', 'dXNlcjpwYXNz'],
    ['git clone https://user:pw12345@example.com/r.git', 'pw12345'],
    ['psql postgres://app:dbpass99@db:5432/x', 'dbpass99'],
  ])('%s', (text, secret) => {
    expect(snippet(text, 500, 'head')).not.toContain(secret);
  });

  it('leaves prose with -key and -token inside words alone', () => {
    expect(snippet('foreign-key constraint', 500, 'head')).toBe('foreign-key constraint');
    expect(snippet('primary-key column and a one-token limit', 500, 'head')).toBe('primary-key column and a one-token limit');
    expect(snippet('run --password hunter2 now', 500, 'head')).not.toContain('hunter2');
    expect(snippet('--password hunter2', 500, 'head')).not.toContain('hunter2');
  });

  it('leaves ordinary text alone', () => {
    expect(snippet('use --keyboard layout and press the key', 500, 'head')).toBe('use --keyboard layout and press the key');
  });
});

describe('composeBody', () => {
  it('is «machine · text» and never longer than PUSH_BODY_MAX', () => {
    expect(composeBody('X1', 'Готово', 'head')).toBe('X1 · Готово');
    const long = composeBody('Очень-длинное-имя-машины-на-много-символов-подряд', 'x '.repeat(300), 'tail');
    expect(long.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(long.startsWith('Очень-длинное')).toBe(true);
    expect(long.endsWith('x')).toBe(true);
    expect(long).toContain('…');
  });

  it('leaves just the machine for an empty text', () => {
    expect(composeBody('X1', '  ', 'head')).toBe('X1');
  });
});

describe('permissionText', () => {
  it('shows the question of AskUserQuestion', () => {
    const input = { questions: [{ question: 'Какой вариант выбрать?', header: 'Выбор', options: [{ label: 'A', description: '' }], multiSelect: false }] };
    expect(permissionText({ tool_name: 'AskUserQuestion', input }, ru)).toBe('Какой вариант выбрать?');
  });

  it('says the plan needs approval', () => {
    expect(permissionText({ tool_name: 'ExitPlanMode', input: { plan: 'secret plan body' } }, en)).toBe('The plan needs your approval');
  });

  it.each([
    [{ command: 'rm -rf /tmp/x' }, 'Bash', 'Permission: Bash rm'],
    [{ command: '/usr/bin/mysql -u root -phunter2 --password hunter2' }, 'Bash', 'Permission: Bash mysql'],
    [{ file_path: '/home/a/b.ts' }, 'Edit', 'Permission: Edit /home/a/b.ts'],
    [{ url: 'https://example.com/a' }, 'WebFetch', 'Permission: WebFetch https://example.com/a'],
    [{}, 'Mystery', 'Permission: Mystery'],
  ])('names the tool and its target %j', (input, tool, expected) => {
    expect(permissionText({ tool_name: tool, input }, en)).toBe(expected);
  });

  it('shows only the program of a command: the arguments never reach the push', () => {
    const text = permissionText({ tool_name: 'Bash', input: { command: `curl -H "Authorization: Bearer topsecret123" ${'a'.repeat(300)}` } }, en);
    expect(text).toBe('Permission: Bash curl');
  });

  it('cuts the target of other tools to 80 characters and redacts secrets', () => {
    const text = permissionText({ tool_name: 'WebFetch', input: { url: `https://user:pw12345@example.com/?token=abc999 ${'a'.repeat(300)}` } }, en);
    expect(text).not.toMatch(/pw12345|abc999/);
    expect(text.length).toBeLessThanOrEqual('Permission: WebFetch '.length + 80);
  });

  it('falls back to the fixed phrase without an open request', () => {
    expect(permissionText(undefined, ru)).toBe('Ход завершён, ждёт ответа');
  });
});

describe('turnText and titleOf', () => {
  it('is the tail of the answer, or the fixed phrase when there is no text', () => {
    const answer = `${'начало '.repeat(100)}Закончил: можно мержить?`;
    const text = turnText(answer, en);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('можно мержить?')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(turnText(undefined, en)).toBe('The turn is finished and waiting for you');
    expect(turnText('   ', ru)).toBe('Ход завершён, ждёт ответа');
  });

  it('puts the title of the session in the language of the user', () => {
    expect(titleOf('Рефакторинг', ru)).toBe('Рефакторинг ждёт ответа');
    expect(titleOf('Refactor', en)).toBe('Refactor is waiting for a reply');
    expect(titleOf('', en)).toBe('Untitled is waiting for a reply');
    expect(titleOf('x'.repeat(200), en).length).toBeLessThanOrEqual(80 + ' is waiting for a reply'.length);
  });
});

describe('failureText (agent-hub-mvp 5.2a)', () => {
  it('a limit of the subscription: the name, and the time of the reset when it is known', () => {
    expect(failureText({ kind: 'limit', name: 'Max' }, ru)).toBe('Лимит подписки Max исчерпан');
    expect(failureText({ kind: 'limit', name: 'Max', time: '18:00' }, ru)).toBe('Лимит подписки Max исчерпан, сброс в 18:00');
    expect(failureText({ kind: 'limit', name: 'Max' }, en)).toBe('Subscription Max: limit reached');
    expect(failureText({ kind: 'limit', name: 'Max', time: '18:00' }, en)).toBe('Subscription Max: limit reached, resets at 18:00');
  });

  it('a rejected token of the subscription; Codex says the ChatGPT sign-in', () => {
    expect(failureText({ kind: 'auth', name: 'Work', codex: false }, ru)).toBe('Токен подписки Work отклонён');
    expect(failureText({ kind: 'auth', name: 'Work', codex: false }, en)).toBe('Subscription Work: token rejected');
    expect(failureText({ kind: 'auth', name: 'Team', codex: true }, ru)).toBe('Вход ChatGPT подписки Team отклонён');
    expect(failureText({ kind: 'auth', name: 'Team', codex: true }, en)).toBe('Subscription Team: ChatGPT sign-in rejected');
  });

  it('a long name is cut, the reason stays within the body', () => {
    const long = failureText({ kind: 'limit', name: 'x'.repeat(200), time: '18:00' }, ru);
    expect(long).toBe(`Лимит подписки ${'x'.repeat(39)}… исчерпан, сброс в 18:00`);
    expect(composeBody('HP', long, 'head').length).toBeLessThanOrEqual(PUSH_BODY_MAX);
  });
});
