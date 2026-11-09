// Navigations the service worker must leave to the hub: server routes and server pages, never the cached shell.
// multi-user: /invite/<code> is a server page — the shell would drop the code and log in without the invite.
// mcp-management: /mcp/oauth/callback is the hub's page the provider returns to after an MCP sign-in.
// keycloak-auth: /id/ is the identity provider on the same domain (sign-in, registration, account page).
export const SW_NAVIGATE_DENYLIST: RegExp[] = [/^\/(api|auth|ws|agent-api|agent|invite|enroll|healthz|metrics|mcp|id)(\/|$)/, /^\/install\.(sh|ps1)$/];
