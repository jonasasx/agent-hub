import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mcpRegistrySnapshotSchema, type mcpRegistrySnapshotSchema as SnapshotSchema } from '@agent-hub/shared';

export type RegistrySnapshot = typeof SnapshotSchema._output;

/** A small, atomic, secret-free offline registry cache. */
export class RegistryCache {
  readonly file: string;
  constructor(stateDir = join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.agent-hub')) {
    this.file = join(stateDir, 'mcp-registry.json');
  }
  async read(): Promise<RegistrySnapshot | null> {
    try {
      const parsed = mcpRegistrySnapshotSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      return parsed;
    } catch {
      return null;
    }
  }
  async write(snapshot: RegistrySnapshot): Promise<void> {
    const safe = mcpRegistrySnapshotSchema.parse(snapshot);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(safe)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
    } catch (error) {
      const { rm } = await import('node:fs/promises');
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
