import { Client } from '@elastic/elasticsearch';
import { config } from '../config.js';
import { prisma } from '../database.js';

const indexName = 'scheduled-emails';
const client = new Client({ node: config.ELASTICSEARCH_URL });
const backfillPageSize = 500;

interface IndexedEmail {
  id: string;
  recipient: string;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
}

let indexReady: Promise<void> | undefined;

async function ensureIndex() {
  if (!indexReady) {
    indexReady = client.indices.create({
      index: indexName,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        dynamic: 'strict',
        properties: {
          id: { type: 'keyword' },
          ownerId: { type: 'keyword' },
          recipient: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          subject: { type: 'text' },
          status: { type: 'keyword' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
        },
      },
    }).then(() => undefined).catch((error: unknown) => {
      const errorType = (error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
      if (errorType !== 'resource_already_exists_exception') {
        indexReady = undefined;
        throw error;
      }
    });
  }
  await indexReady;
}

/** Rebuild the search projection from PostgreSQL. Run as an operator command. */
export async function rebuildEmailSearchIndex() {
  indexReady = undefined;
  try {
    await client.indices.delete({ index: indexName });
  } catch (error) {
    const statusCode = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (statusCode !== 404) throw error;
  }
  await ensureIndex();

  let cursor: string | undefined;
  let indexed = 0;
  for (;;) {
    const emails = await prisma.scheduledEmail.findMany({
      orderBy: { id: 'asc' },
      take: backfillPageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        recipient: true,
        status: true,
        scheduledAt: true,
        sentAt: true,
        updatedAt: true,
        batch: { select: { ownerId: true, subject: true } },
      },
    });
    if (!emails.length) break;

    const result = await client.bulk({
      operations: emails.flatMap((email) => [
        { index: { _index: indexName, _id: email.id, version: email.updatedAt.getTime(), version_type: 'external_gte' } },
        {
          id: email.id,
          ownerId: email.batch.ownerId,
          recipient: email.recipient,
          subject: email.batch.subject,
          status: email.status.toLowerCase(),
          scheduledAt: email.scheduledAt,
          sentAt: email.sentAt,
        },
      ]),
      refresh: false,
    });
    if (result.errors) throw new Error('Elasticsearch bulk backfill reported document errors.');
    indexed += emails.length;
    cursor = emails.at(-1)!.id;
    if (emails.length < backfillPageSize) break;
  }
  await client.indices.refresh({ index: indexName });
  return indexed;
}

export async function indexEmailById(emailId: string) {
  await ensureIndex();
  const email = await prisma.scheduledEmail.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      recipient: true,
      status: true,
      scheduledAt: true,
      sentAt: true,
      updatedAt: true,
      batch: { select: { ownerId: true, subject: true } },
    },
  });

  if (!email) {
    await client.delete({ index: indexName, id: emailId }, { ignore: [404] });
    return;
  }

  await client.index({
    index: indexName,
    id: email.id,
    version: email.updatedAt.getTime(),
    version_type: 'external_gte',
    document: {
      id: email.id,
      ownerId: email.batch.ownerId,
      recipient: email.recipient,
      subject: email.batch.subject,
      status: email.status.toLowerCase(),
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
    },
  });
}

export async function searchIndexedEmails(ownerId: string, query: string, status: string | undefined, limit: number) {
  await ensureIndex();
  const result = await client.search<IndexedEmail>({
    index: indexName,
    size: limit,
    query: {
      bool: {
        must: query ? [{ multi_match: { query, fields: ['recipient', 'subject'] } }] : [{ match_all: {} }],
        filter: [
          { term: { ownerId } },
          ...(status ? [{ term: { status } }] : []),
        ],
      },
    },
    sort: [{ scheduledAt: 'desc' }, { _id: 'asc' }],
  });

  return result.hits.hits.flatMap((hit) => hit._source ? [hit._source] : []);
}
