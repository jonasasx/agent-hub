import type { RegistrySnapshot } from './registryCache.js';

/** Servers of a session's project: a server bound to projects goes only to sessions of those projects, then explicit disabled overrides apply. */
export function serversForProject(snapshot: RegistrySnapshot, projectId: string | undefined) {
  const scoped = snapshot.servers.filter(server => server.projectIds.length === 0 || (projectId !== undefined && server.projectIds.includes(projectId)));
  if (!projectId) return scoped;
  const disabled = new Set((snapshot.projectOverrides ?? []).filter(override => override.projectId === projectId && override.enabled === false).map(override => override.serverId));
  return scoped.filter(server => !disabled.has(server.id));
}
