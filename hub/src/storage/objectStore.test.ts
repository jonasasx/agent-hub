import { describe, expect, it } from 'vitest';
import { createS3Client } from './objectStore.js';

describe('createS3Client (paas-deployment D1)', () => {
  it('an S3-compatible store: endpoint, path-style addressing and static keys', async () => {
    const client = createS3Client({
      region: 'region-1',
      endpoint: 'https://s3.example.com',
      forcePathStyle: true,
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe('s3.example.com');
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe('region-1');
    const credentials = await client.config.credentials();
    expect(credentials.accessKeyId).toBe('key');
    expect(credentials.secretAccessKey).toBe('secret');
  });

  it('AWS: only the region, no endpoint and no path-style; keys come from the default chain', async () => {
    const client = createS3Client({ region: 'eu-central-1' });
    expect(client.config.endpoint).toBeUndefined();
    expect(client.config.forcePathStyle).toBeFalsy();
    expect(await client.config.region()).toBe('eu-central-1');
  });

  it('one key without the other is not used: the default chain stays', async () => {
    const client = createS3Client({ region: 'region-1', accessKeyId: 'key' });
    const previous = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ACCESS_KEY_ID = 'chain-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'chain-secret';
    try {
      expect((await client.config.credentials()).accessKeyId).toBe('chain-key');
    } finally {
      if (previous.id === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = previous.id;
      if (previous.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
    }
  });
});
