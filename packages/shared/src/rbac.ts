export const ROLES = ['owner', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Matriz de permissões (PRD FR-AUTH-03). Novas permissões entram aqui e são verificadas
 * pelo guard da API com o decorator @RequirePermission().
 */
export const PERMISSIONS = {
  'tenants.read': ['owner', 'operator', 'viewer'],
  'tenants.write': ['owner', 'operator'],
  'tenants.settings.write': ['owner'],
  'tenants.delete_data': ['owner'],
  'users.manage': ['owner'],
  'audit.read': ['owner'],
  'costs.read': ['owner'],
  'assets.read': ['owner', 'operator', 'viewer'],
  'assets.write': ['owner', 'operator'],
  'campaigns.read': ['owner', 'operator', 'viewer'],
  'campaigns.write': ['owner', 'operator'],
  'secrets.manage': ['owner'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
