import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { CLASSIFIER_SYSTEM_PROMPT, parseClassification, redactClassifierText, SubscriptionProjectClassifier } from './haiku.js';
import { deterministicProject } from './detection.js';
const id = '8a1cf5b9-5ef6-4f66-8cfa-0a6102907f06';
const env = {
  PUBLIC_URL: 'https://test.example',
  DATABASE_URL: 'postgres://localhost/test',
  COOKIE_SECRET: 'x'.repeat(40),
  OIDC_CLIENT_ID: 'test',
  OIDC_CLIENT_SECRET: 'test',
  OIDC_ALLOWED_EMAILS: 'admin@example.test',
};

describe('catalog deterministic rules', () => {
  const a = { id, remote: 'git@example.test:team/a.git', paths: ['C:\\work\\a'] };
  const b = { id: 'other', remote: 'https://example.test/team/b', paths: ['C:\\work\\b'] };
  it('prioritizes exact cwd, then normalized remote, then edits; never parent cwd or reads', () => {
    expect(deterministicProject([a, b], 'c:/WORK/a/', b.remote, ['C:/work/b/file'])).toEqual({ id, reason: 'cwd' });
    expect(deterministicProject([a, b], 'C:/work', 'https://example.test/team/a', [])).toEqual({ id, reason: 'remote' });
    expect(deterministicProject([a, b], 'C:/work', null, ['C:/work/a/file'])).toEqual({ id, reason: 'changed_files' });
    expect(deterministicProject([a], 'C:/work', null, [])).toBeNull();
    expect(deterministicProject([a], 'C:/work/a/subdir', null, [])).toBeNull();
    expect(deterministicProject([a], null, null, ['C:/work/ab/file'])).toBeNull();
    expect(deterministicProject([a, b], null, null, ['C:/work/a/f', 'C:/work/b/f'])).toBeNull();
  });
  it('does not guess among conflicting exact signals and respects POSIX case', () => {
    expect(deterministicProject([a, { ...b, paths: a.paths }], a.paths[0]!, null, [])).toBeNull();
    expect(deterministicProject([{ ...a, paths: ['/work/A'] }], '/work/a', null, [])).toBeNull();
  });
});

describe('subscription classifier', () => {
  it('is on by default and bounds the message count', () => {
    const config = loadConfig(env);
    expect(config.PROJECT_CLASSIFIER_ENABLED).toBe(true);
    expect(config.PROJECT_CLASSIFIER_AUTO_CONFIDENCE).toBe(0.8);
    expect(() => loadConfig({ ...env, PROJECT_CLASSIFIER_MAX_MESSAGES: '6' })).toThrow();
  });
  it('sends the prompt through the runner and validates the JSON answer', async () => {
    const answer = { projectId: id, confidence: 0.9, reasonCode: 'topic_match', alternatives: [], newProjectName: null };
    const run = vi.fn().mockResolvedValue('Ответ:\n```json\n' + JSON.stringify(answer) + '\n```');
    const classifier = new SubscriptionProjectClassifier(run, { model: 'claude-haiku-4-5-20251001', timeoutMs: 1000 });
    expect(await classifier.classify('user-1', '{"messages":[]}', AbortSignal.timeout(1000))).toMatchObject({ projectId: id, confidence: 0.9 });
    expect(run).toHaveBeenCalledWith('user-1', expect.objectContaining({ prompt: '{"messages":[]}', systemPrompt: CLASSIFIER_SYSTEM_PROMPT, model: 'claude-haiku-4-5-20251001' }));
    expect(parseClassification('{"projectId":null,"confidence":0.2,"reasonCode":"no_project","newProjectName":"VPN"}')).toMatchObject({
      alternatives: [],
      newProjectName: 'VPN',
    });
    for (const text of ['not JSON', '{"projectId":null,"confidence":2,"reasonCode":"no_project"}', '{"projectId":null,"confidence":0,"reasonCode":"secret text"}']) {
      expect(() => parseClassification(text)).toThrow();
    }
  });
  it('redacts recognizable credentials from messages and metadata', () => {
    const value = redactClassifierText(
      'password=hunter2 token=abc sk-ant-' +
        'api03-topsecret Bearer xyz https://alice:secret@example.test/r\nPrivateKey = abc\n-----BEGIN ' +
        'PRIVATE KEY-----\nsecret\n-----END ' +
        'PRIVATE KEY-----',
    );
    for (const secret of ['hunter2', 'abc', 'sk-ant', 'xyz', 'alice', '\nsecret\n']) expect(value).not.toContain(secret);
  });
});
