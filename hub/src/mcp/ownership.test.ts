import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const USER_TABLES = [
  'mcp_registry_servers',
  'mcp_registry_meta',
  'mcp_registry_overrides',
  'mcp_secrets',
  'mcp_registry_drafts',
  'mcp_registry_imports',
  'mcp_oauth_tokens',
  'mcp_oauth_statuses',
  'mcp_gateway_statuses',
  'mcp_registry_session_updates',
  'mcp_registry_audit',
];
const ALLOWED: Array<[file: string, fragment: string, reason: string]> = [
  ['registry.ts', "deleteFrom('mcp_gateway_statuses')", 'the server and runner are checked against the authenticated owner before deleting the scoped status'],
];

function statements(src: string): Array<{ start: number; text: string }> {
  const result: Array<{ start: number; text: string }> = [];
  const pattern = /(selectFrom|updateTable|deleteFrom|insertInto)\(\s*'([a-z_]+)(?: as \w+)?'/g;
  for (let match = pattern.exec(src); match; match = pattern.exec(src)) {
    if (!USER_TABLES.includes(match[2]!)) continue;
    if (match[1] === 'insertInto') continue;
    const end = src.indexOf(';', match.index);
    result.push({ start: match.index, text: src.slice(match.index, end === -1 ? undefined : end) });
  }
  return result;
}

describe('mcp/: every user table query is scoped by user_id', () => {
  const files = readdirSync(DIR).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));

  it.each(files)('%s', file => {
    const source = readFileSync(`${DIR}${file}`, 'utf8');
    const unscoped = statements(source)
      .filter(statement => !/user_id/.test(statement.text))
      .filter(statement => !ALLOWED.some(([allowedFile, fragment]) => allowedFile === file && statement.text.includes(fragment)))
      .map(statement => `${file}:${source.slice(0, statement.start).split('\n').length}`);
    expect(unscoped).toEqual([]);
  });

  it('detects an unscoped query', () => {
    const source = "db.selectFrom('mcp_registry_servers').selectAll().where('id', '=', id).execute();";
    expect(statements(source).filter(statement => !/user_id/.test(statement.text))).toHaveLength(1);
  });
});
