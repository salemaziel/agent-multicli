#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './serverApp.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

async function main() {
  const app = await startServer(config);

  const shutdown = (signalName: string) => {
    logger.info('Received shutdown signal', { signalName });
    void app.close(`Received ${signalName}`);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('Server startup failed', { error });
  process.exit(1);
});
