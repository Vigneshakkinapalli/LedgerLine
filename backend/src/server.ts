import { app } from './app.js';
import { config } from './config.js';

app.listen(config.PORT, () => console.log(JSON.stringify({ level: 'info', message: 'LedgerLine API started', port: config.PORT })));
