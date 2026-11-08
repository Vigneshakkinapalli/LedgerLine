import { pool } from './db/pool.js';
import { pollScheduledReconciliation } from './financial/reporting.js';
import { pollScheduledPayments } from './financial/scheduled-payments.js';
import { pollRecurringPayments } from './financial/recurring-payments.js';

let stopped = false;
let running = false;

async function poll() {
  if (stopped || running) return;
  running = true;
  try {
    const completed = await pollScheduledReconciliation();
    if (completed) console.log(JSON.stringify({ level: 'info', event: 'scheduled_reconciliation_completed' }));
    const paymentOccurrences = await pollScheduledPayments();
    if (paymentOccurrences) console.log(JSON.stringify({ level: 'info', event: 'scheduled_payment_occurrences_processed', count: paymentOccurrences }));
    const recurringOccurrences = await pollRecurringPayments();
    if (recurringOccurrences) console.log(JSON.stringify({ level: 'info', event: 'recurring_payment_occurrences_processed', count: recurringOccurrences }));
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'scheduled_reconciliation_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
  } finally { running = false; }
}

const timer = setInterval(() => { void poll(); }, 60_000);
void poll();

async function shutdown() {
  stopped = true;
  clearInterval(timer);
  while (running) await new Promise(resolve => setTimeout(resolve, 50));
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
console.log(JSON.stringify({ level: 'info', event: 'ledgerline_worker_started', tasks: ['scheduled_reconciliation', 'scheduled_payments', 'recurring_payments'], pollIntervalSeconds: 60 }));
