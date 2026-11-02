import type { RegistrySnapshot } from './registryCache.js';

/** Apply only explicit disabled overrides for the project resolved by the hub. */
export function serversForProject(snapshot: RegistrySnapshot, projectId: string | undefined) {
  if (!projectId) return snapshot.servers;
  const disabled = new Set((snapshot.projectOverrides ?? []).filter(override => override.projectId === projectId && override.enabled === false).map(override => override.serverId));
  return snapshot.servers.filter(server => !disabled.has(server.id));
}
