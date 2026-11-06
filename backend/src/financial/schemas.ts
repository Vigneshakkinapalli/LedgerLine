import { z } from 'zod';

export const amountSchema = z.string().regex(/^[1-9][0-9]*$/, 'amountPaise must be a positive integer string').refine(value => BigInt(value) <= 9223372036854775807n, 'amountPaise is too large');
export const transferSchema = z.object({ destinationAccountId: z.string().uuid(), amountPaise: amountSchema }).strict();
export const amountOnlySchema = z.object({ amountPaise: amountSchema }).strict();
export const statusSchema = z.object({ status: z.enum(['active', 'frozen', 'closed']) }).strict();
export const limitSchema = z.object({ dailyDebitLimitPaise: amountSchema, dailyCreditLimitPaise: amountSchema }).strict();
export type Operation = 'deposit' | 'withdrawal' | 'transfer';
