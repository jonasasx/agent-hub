// One check against the real data bucket (D7): put/get/list/exists/delete under test/<random>/, cleaned up after.
// Opt-in: AGENT_HUB_S3_TEST=1 with AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY of IAM user agent-hub and S3_BUCKET_DATA.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3Store } from './objectStore.js';
import { assemble, compress, rawPrefix, writeSegment } from '../replication/raw.js';

const RUN = process.env.AGENT_HUB_S3_TEST === '1';

describe.skipIf(!RUN)('S3Store against the real bucket (test/ prefix)', () => {
  it('stores, lists, reads and deletes objects; raw segments assemble', { timeout: 60_000 }, async () => {
    const store = new S3Store(process.env.S3_BUCKET_DATA ?? 'agent-hub-test-data', process.env.AWS_REGION ?? 'eu-central-1', `test/${randomUUID()}/`);
    await store.check();
    const keys: string[] = [];
    try {
      await store.put('blobs/a', Buffer.from('привет'), 'text/plain; charset=utf-8');
      keys.push('blobs/a');
      expect((await store.get('blobs/a'))!.toString('utf8')).toBe('привет');
      expect(await store.exists('blobs/a')).toBe(true);
      expect(await store.exists('blobs/none')).toBe(false);
      expect(await store.get('blobs/none')).toBeNull();
      const prefix = rawPrefix('hp', randomUUID(), 'c--x/s.jsonl', 0);
      keys.push(await writeSegment(store, prefix, 0, ['{"a":1}', '{"b":2}']));
      keys.push(await writeSegment(store, prefix, 2, ['{"c":3}']));
      expect((await assemble(store, prefix)).content.toString('utf8')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
      expect(await store.list(prefix)).toHaveLength(2);
      expect(compress('x').length).toBeGreaterThan(0);
    } finally {
      await store.delete(keys);
    }
    expect(await store.exists('blobs/a')).toBe(false);
  });
});
