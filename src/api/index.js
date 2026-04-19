import { createServer } from './server.js';
import { config } from '../config.js';
import { logger } from '../infrastructure/logger.js';

const port = config.api.port;
const app = createServer();

app.listen(port, () => {
  logger.info('API server listening', {
    port,
    authEnabled: !!config.api.key,
    endpoints: ['GET /health', 'GET /metrics', 'POST /transactions/fetch'],
  });
});
