import { z } from 'zod';

export const amountSchema = z.string().regex(/^[1-9][0-9]*$/, 'amountPaise must be a positive integer string').refine(value => BigInt(value) <= 9223372036854775807n, 'amountPaise is too large');
export const transferSchema = z.object({ destinationAccountId: z.string().uuid(), amountPaise: amountSchema }).strict();
export const amountOnlySchema = z.object({ amountPaise: amountSchema }).strict();
export const statusSchema = z.object({ status: z.enum(['active', 'frozen', 'closed']) }).strict();
export const limitSchema = z.object({ dailyDebitLimitPaise: amountSchema, dailyCreditLimitPaise: amountSchema }).strict();
export const statementQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const analyticsQuerySchema = z.object({
	startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	accountId: z.string().uuid().optional(),
	transactionType: z.enum(['deposit', 'withdrawal', 'transfer', 'reversal']).optional(),
	status: z.enum(['posted', 'reversed', 'failed', 'pending']).optional(),
	granularity: z.enum(['day', 'week', 'month']).default('day')
}).strict().refine(value => !value.startDate || !value.endDate || value.startDate <= value.endDate, { message: 'startDate must not be after endDate' });
export const reconciliationFindingUpdateSchema = z.object({ status: z.enum(['investigating', 'resolved']), resolutionNote: z.string().trim().min(3).max(2000) }).strict();
export const reconciliationScheduleSchema = z.object({ enabled: z.boolean(), cadence: z.enum(['daily', 'weekly']) }).strict();
const scheduledPaymentCommonSchema = z.object({
	sourceAccountId: z.string().uuid(),
	destinationAccountId: z.string().uuid(),
	amountPaise: amountSchema,
				description: z.string().trim().min(1).max(255),
	retryLimit: z.number().int().min(0).max(10).default(3),
	retryDelayMinutes: z.number().int().min(1).max(1440).default(60),
	reminderMinutes: z.number().int().min(0).max(10080).default(1440)
}).strict();
export const scheduledPaymentCreateSchema = scheduledPaymentCommonSchema.extend({ executeAt: z.string().datetime({ offset: true }) })
	.refine(value => new Date(value.executeAt) > new Date(), { message: 'executeAt must be in the future' });
export const recurringPaymentCreateSchema = scheduledPaymentCommonSchema.extend({
	frequency: z.enum(['daily', 'weekly', 'monthly']),
	startAt: z.string().datetime({ offset: true }),
	endsAt: z.string().datetime({ offset: true }).optional()
}).refine(value => !value.endsAt || new Date(value.endsAt) >= new Date(value.startAt), { message: 'endsAt must be on or after startAt' })
	.refine(value => new Date(value.startAt) > new Date(), { message: 'startAt must be in the future' });
export const scheduledPaymentActionSchema = z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).strict();
export type Operation = 'deposit' | 'withdrawal' | 'transfer';
