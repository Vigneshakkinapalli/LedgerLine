export const ROLE_NAMES = ['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: RoleName[];
  sessionId: string;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string | null;
  roles: RoleName[];
  createdAt: string;
}
