import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default('postgres://ledgerline:ledgerline@localhost:5433/ledgerline'),
  JWT_SECRET: z.string().min(32).default('development-only-secret-change-me-123456'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  HIGH_VALUE_THRESHOLD_PAISE: z.coerce.bigint().positive().default(10000000n),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info')
});

const parsed = envSchema.parse(process.env);
if (parsed.NODE_ENV === 'production' && parsed.JWT_SECRET === 'development-only-secret-change-me-123456') {
  throw new Error('JWT_SECRET must be explicitly configured in production');
}
export const config = parsed;
