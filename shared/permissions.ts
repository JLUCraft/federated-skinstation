/** P0 permission catalog. Business permissions belong here when their owners ship. */
export const PERMISSIONS = {
  admin: { globalOnly: false },
  manage: { globalOnly: false },
  president: { globalOnly: false },
  read: { globalOnly: false },
  write: { globalOnly: false },
  'members.manage': { globalOnly: false },
  'chairs.manage': { globalOnly: false },
  'grants.manage': { globalOnly: false },
  'services.manage': { globalOnly: false },
  'accounts.disable': { globalOnly: true },
} as const;
export type Permission = keyof typeof PERMISSIONS;
export type ScopeKind = 'club' | 'service' | 'league' | 'event' | 'workflow';
export type Scope = 'global' | `${ScopeKind}:${string}`;
export function parseScope(value: string): { kind: 'global' | ScopeKind; id?: string } | undefined {
  if (value === 'global') return { kind: 'global' };
  const match = /^(club|service|league|event|workflow):([^:\s]+)$/.exec(value);
  return match ? { kind: match[1] as ScopeKind, id: match[2] } : undefined;
}
export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}
export function permissionImplies(held: string, requested: Permission): boolean {
  return held === requested || held === 'admin' ||
    (!PERMISSIONS[requested].globalOnly && held === 'manage');
}
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  president: ['manage'],
  member: ['read'],
};

export interface PermissionSource {
  enabled(account: string): boolean;
  /** undefined means an unknown resource; global has no parent. */
  parent(scope: Scope): Scope | null | undefined;
  membership(account: string, club: string): { active: boolean; roles: string[] } | undefined;
  chair(account: string, club: string): boolean;
  grants(account: string, scope: Scope): string[];
  audit(account: string, scope: string, permission: string, allowed: boolean): void;
}

/** Bind to a server-owned snapshot/transaction; never trust client-supplied membership. */
export function createAuthorizer(source: PermissionSource) {
  return function authorize(account: string, scope: string, permission: string): boolean {
    const decide = () => {
      if (!source.enabled(account) || !parseScope(scope) || !isPermission(permission)) return false;
      if (source.grants(account, 'global').includes('admin')) return true;
      if (PERMISSIONS[permission].globalOnly)
        return source.grants(account, 'global').includes(permission);
      const ancestors: Scope[] = [];
      let current: Scope | null | undefined = scope as Scope;
      while (current !== null) {
        if (current === undefined || ancestors.includes(current)) return false;
        ancestors.push(current);
        current = source.parent(current);
      }
      for (const ancestor of ancestors) {
        const parsed = parseScope(ancestor)!;
        if (parsed.kind === 'club' && !source.membership(account, parsed.id!)?.active) return false;
      }
      for (const ancestor of ancestors) {
        if (source.grants(account, ancestor).some(p => permissionImplies(p, permission))) return true;
        const parsed = parseScope(ancestor)!;
        if (parsed.kind !== 'club') continue;
        const roles = source.membership(account, parsed.id!)!.roles;
        if (source.chair(account, parsed.id!)) {
          if (permission === 'president' ||
              ROLE_PERMISSIONS.president.some(p => permissionImplies(p, permission))) return true;
        }
        if (roles.some(role => {
          // President authority comes only from chairs, never from a cached role.
          if (typeof role !== 'string' || role === 'president') return false;
          const held = Object.hasOwn(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : [role];
          return held.some(p => isPermission(p) && permissionImplies(p, permission));
        })) return true;
      }
      return false;
    };
    const allowed = decide();
    source.audit(account, scope, permission, allowed);
    return allowed;
  };
}
