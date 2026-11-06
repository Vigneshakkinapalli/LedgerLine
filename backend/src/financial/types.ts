import type { AuthenticatedUser } from '../auth/types.js';
import type { Operation } from './schemas.js';

export interface OperationInput {
  operation: Operation;
  accountId: string;
  destinationAccountId?: string;
  amountPaise: bigint;
  idempotencyKey: string;
  actor: AuthenticatedUser;
  correlationId?: string;
}

export interface OperationResult {
  status: number;
  body: Record<string, unknown>;
}
