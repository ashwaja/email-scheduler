import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';

const server = createApp().listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'API listening');
});

function stop(signal: string) {
  logger.info({ signal }, 'Shutting down API');
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'API shutdown failed');
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  });
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
