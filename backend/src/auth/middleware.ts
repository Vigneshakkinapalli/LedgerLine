import type { RequestHandler } from 'express';
import { authenticate, requireRoles } from '../middleware.js';

export { authenticate, requireRoles };

export const requireAdmin: RequestHandler[] = [authenticate, requireRoles('ADMIN')];
export const requireAdminOrAuditor: RequestHandler[] = [authenticate, requireRoles('ADMIN', 'AUDITOR')];
