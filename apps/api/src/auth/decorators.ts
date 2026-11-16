import type { Permission } from '@bm/shared';
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'bm:isPublic';
export const PERMISSION = 'bm:permission';

/** Rota sem sessão (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Exige uma permissão da matriz RBAC (packages/shared/src/rbac.ts). */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION, permission);
