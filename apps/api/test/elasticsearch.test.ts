import { beforeEach, describe, expect, it, vi } from 'vitest';

const { elastic, findMany, findUnique } = vi.hoisted(() => ({
  elastic: {
    create: vi.fn(),
    delete: vi.fn(),
    refresh: vi.fn(),
    bulk: vi.fn(),
    index: vi.fn(),
    search: vi.fn(),
  },
  findMany: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock('@elastic/elasticsearch', () => ({
  Client: class {
    indices = { create: elastic.create, delete: elastic.delete, refresh: elastic.refresh };
    bulk = elastic.bulk;
    index = elastic.index;
    search = elastic.search;
  },
}));
vi.mock('../src/config.js', () => ({ config: { ELASTICSEARCH_URL: 'http://localhost:9200' } }));
vi.mock('../src/database.js', () => ({ prisma: { scheduledEmail: { findMany, findUnique } } }));

describe('Elasticsearch email projection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    elastic.create.mockResolvedValue({});
    elastic.delete.mockResolvedValue({});
    elastic.refresh.mockResolvedValue({});
    elastic.bulk.mockResolvedValue({ errors: false });
    elastic.index.mockResolvedValue({});
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(null);
  });

  it('creates a mapped index and rebuilds documents for every persisted email state', async () => {
    const sentAt = new Date('2026-01-02T03:04:05Z');
    findMany.mockResolvedValueOnce([{
      id: 'email-1', recipient: 'person@example.com', status: 'SENT',
      scheduledAt: new Date('2026-01-02T03:00:00Z'), sentAt,
      updatedAt: new Date('2026-01-02T03:04:06Z'),
      batch: { ownerId: 'owner-1', subject: 'Hello' },
    }]).mockResolvedValueOnce([]);

    const { rebuildEmailSearchIndex } = await import('../src/search/emails.js');
    await expect(rebuildEmailSearchIndex()).resolves.toBe(1);

    expect(elastic.delete).toHaveBeenCalledWith({ index: 'scheduled-emails' });
    expect(elastic.create).toHaveBeenCalledWith(expect.objectContaining({
      index: 'scheduled-emails',
      mappings: expect.objectContaining({
        dynamic: 'strict',
        properties: expect.objectContaining({ ownerId: { type: 'keyword' }, status: { type: 'keyword' } }),
      }),
    }));
    expect(elastic.bulk).toHaveBeenCalledWith(expect.objectContaining({
      operations: [
        expect.objectContaining({ index: expect.objectContaining({ _id: 'email-1', version_type: 'external_gte' }) }),
        expect.objectContaining({ id: 'email-1', ownerId: 'owner-1', recipient: 'person@example.com', subject: 'Hello', status: 'sent', sentAt }),
      ],
    }));
    expect(elastic.refresh).toHaveBeenCalledWith({ index: 'scheduled-emails' });
  });

  it('searches recipient and subject with a mandatory owner filter and optional status', async () => {
    elastic.search.mockResolvedValue({ hits: { hits: [{ _source: {
      id: 'email-1', recipient: 'person@example.com', subject: 'Hello', status: 'scheduled',
      scheduledAt: '2026-01-02T03:00:00Z', sentAt: null,
    } }] } });
    const { searchIndexedEmails } = await import('../src/search/emails.js');
    const emails = await searchIndexedEmails('owner-1', 'hello', 'scheduled', 10);

    expect(emails).toHaveLength(1);
    expect(elastic.search).toHaveBeenCalledWith(expect.objectContaining({
      query: { bool: {
        must: [{ multi_match: { query: 'hello', fields: ['recipient', 'subject'] } }],
        filter: [{ term: { ownerId: 'owner-1' } }, { term: { status: 'scheduled' } }],
      } },
    }));
  });

  it('uses the email primary key as its idempotent Elasticsearch document id', async () => {
    findUnique.mockResolvedValue({
      id: 'email-1', recipient: 'person@example.com', status: 'FAILED',
      scheduledAt: new Date('2026-01-02T03:00:00Z'), sentAt: null,
      updatedAt: new Date('2026-01-02T03:04:06Z'), batch: { ownerId: 'owner-1', subject: 'Hello' },
    });
    const { indexEmailById } = await import('../src/search/emails.js');
    await indexEmailById('email-1');
    await indexEmailById('email-1');
    expect(elastic.index).toHaveBeenCalledTimes(2);
    expect(elastic.index).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'email-1', version_type: 'external_gte' }));
    expect(elastic.index).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'email-1', version_type: 'external_gte' }));
  });
});
