import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../log.js';
import { RegistryCacheWriter } from './registryCacheWriter.js';
import type { RegistryCache, RegistrySnapshot } from './registryCache.js';

function snapshot(revision: number): RegistrySnapshot {
  return {
    protocol: '1.13',
    revision,
    generatedAt: revision,
    registryEnabled: true,
    servers: [],
  };
}

describe('RegistryCacheWriter', () => {
  it('continues with the next snapshot after a write failure', async () => {
    const written: number[] = [];
    const write = vi.fn(async (value: RegistrySnapshot) => {
      written.push(value.revision);
      if (value.revision === 1) throw new Error('disk error');
    });
    const cache = { write } as unknown as RegistryCache;
    const warnings: string[] = [];
    const writer = new RegistryCacheWriter(cache, createLogger({ level: 'warn', write: line => warnings.push(line) }));

    writer.enqueue(snapshot(1));
    writer.enqueue(snapshot(2));
    expect(await writer.flush()).toBe(true);
    expect(written).toEqual([1, 2]);
    expect(warnings.join('\n')).toContain('MCP registry cache write failed');
  });

  it('compresses pending writes to the latest registry snapshot', async () => {
    const written: number[] = [];
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });
    let firstWriteStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      firstWriteStarted = resolve;
    });
    const write = vi.fn(async (value: RegistrySnapshot) => {
      written.push(value.revision);
      if (value.revision === 1) {
        firstWriteStarted();
        await firstWriteGate;
      }
    });
    const writer = new RegistryCacheWriter({ write } as unknown as RegistryCache, createLogger({ level: 'error', write: () => undefined }));

    writer.enqueue(snapshot(1));
    await firstStarted;
    writer.enqueue(snapshot(2));
    writer.enqueue(snapshot(3));
    releaseFirstWrite();

    expect(await writer.flush()).toBe(true);
    expect(written).toEqual([1, 3]);
  });

  it('bounds shutdown waiting while a cache write is still pending', async () => {
    const write = vi.fn(() => new Promise<void>(() => undefined));
    const writer = new RegistryCacheWriter({ write } as unknown as RegistryCache, createLogger({ level: 'error', write: () => undefined }));
    writer.enqueue(snapshot(1));

    expect(await writer.flush(20)).toBe(false);
  });
});
