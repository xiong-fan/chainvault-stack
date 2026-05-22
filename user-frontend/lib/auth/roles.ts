import type { AuthUser } from '@/lib/api/auth-api';

const RISK_OPERATOR_TYPES = new Set([
  'sys_admin',
  'admin',
  'risk_operator',
  'customer_service',
  'support'
]);

export function canAccessRiskControl(user?: Pick<AuthUser, 'user_type'>) {
  return Boolean(user?.user_type && RISK_OPERATOR_TYPES.has(user.user_type));
}

export function canManageUserTypes(user?: Pick<AuthUser, 'user_type'>) {
  return Boolean(user?.user_type && ['sys_admin', 'admin'].includes(user.user_type));
}
