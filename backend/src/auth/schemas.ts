import { z } from 'zod';
import { ROLE_NAMES } from './types.js';

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(320).transform(value => value.toLowerCase()),
  password: z.string().min(12).max(128)
}).strict();

export const registrationSchema = credentialsSchema.extend({
  fullName: z.string().trim().min(1).max(120)
}).strict();

export const roleUpdateSchema = z.object({
  roles: z.array(z.enum(ROLE_NAMES)).min(1).max(3)
}).strict();

export const permissionSchema = z.object({
  userId: z.string().uuid(),
  permission: z.enum(['view', 'deposit', 'withdraw', 'transfer'])
}).strict();
