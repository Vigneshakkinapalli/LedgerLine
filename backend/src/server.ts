import { app } from './app.js';
import { config } from './config.js';

const shouldRunWorkerInProcess = process.env.RUN_WORKER_IN_PROCESS === '1';
if (shouldRunWorkerInProcess) {
  const { startWorker } = await import('./worker.js');
  startWorker(60_000);
}

app.listen(config.PORT, () => console.log(JSON.stringify({ level: 'info', message: 'LedgerLine API started', port: config.PORT, workerInProcess: shouldRunWorkerInProcess })));
