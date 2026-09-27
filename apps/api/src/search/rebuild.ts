import { prisma } from '../database.js';
import { logger } from '../logger.js';
import { rebuildEmailSearchIndex } from './emails.js';

try {
  const indexed = await rebuildEmailSearchIndex();
  logger.info({ indexed }, 'Elasticsearch email index rebuilt from PostgreSQL');
} catch (error) {
  logger.fatal({ err: error }, 'Elasticsearch email index rebuild failed');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
