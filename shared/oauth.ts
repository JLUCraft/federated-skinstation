import { oAuthScopeSchema, type OAuthScope } from './contracts/generated.js';
export const MCP_PATH = '/mcp';
export const OAUTH_TOKEN_CLIENT_PREFIX = 'oauth:';
export const MCP_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
export const OAUTH_PATHS = {
  authorize: '/api/oauth/authorize',
  register: '/api/oauth/register',
  review: '/api/oauth/authorization',
  grants: '/api/oauth/grants',
  token: '/api/oauth/token',
  revoke: '/api/oauth/revoke',
} as const;
export const OAUTH_SCOPES = oAuthScopeSchema.enum;
export const MCP_READ_SCOPE: OAuthScope = 'mcp.read';
export const MCP_WRITE_SCOPE: OAuthScope = 'mcp.write';
export const agentScopes = OAUTH_SCOPES.filter((scope) => !scope.startsWith('Yggdrasil.'));
export const gameScopes = OAUTH_SCOPES.filter((scope) => !scope.startsWith('mcp.'));
export function parseOAuthScopes(
  value: unknown,
  allowed: readonly OAuthScope[],
): OAuthScope[] | undefined {
  if (typeof value !== 'string') return undefined;
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (!scopes.every((scope): scope is OAuthScope => allowed.some((item) => item === scope)))
    return undefined;
  return scopes;
}
export function mcpScopeAllows(scopes: readonly string[], write: boolean) {
  return scopes.includes(MCP_WRITE_SCOPE) || (!write && scopes.includes(MCP_READ_SCOPE));
}
