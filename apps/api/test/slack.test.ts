import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SLACK_CLIENT_ID ||= 'slack-test-client-id';
process.env.SLACK_CLIENT_SECRET ||= 'slack-test-client-secret';
process.env.ENCRYPTION_KEY_BASE64 ||= Buffer.alloc(32, 7).toString('base64');

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  redisSet: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/database.js', () => ({
  prisma: { slackInstallation: { upsert: mocks.upsert, findUnique: mocks.findUnique } },
}));
vi.mock('../src/redis.js', () => ({ redis: { set: mocks.redisSet } }));
vi.mock('../src/logger.js', () => ({ logger: { warn: mocks.warn } }));

const [{ createAuthRouter }, { passport }, { encryptSecret, decryptSecret }, { notifySenderCap }] = await Promise.all([
  import('../src/auth/routes.js'),
  import('../src/auth/passport.js'),
  import('../src/security/secrets.js'),
  import('../src/slack/notifications.js'),
]);

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
const webhookUrl = 'https://hooks.slack.test/services/private-webhook-token';
const requestFetch = globalThis.fetch.bind(globalThis);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisSet.mockResolvedValue('OK');
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({});
});

async function startSlackAuthServer() {
  const app = express();
  app.use(session({
    name: 'reachinbox.sid',
    secret: 'slack-test-session-secret-that-is-long-enough',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false },
  }));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use((request, _response, next) => {
    if (request.get('x-test-auth') === 'yes') {
      request.user = { id: 'slack-owner', name: 'Slack User', email: 'slack@example.com', avatarUrl: null };
      request.isAuthenticated = () => true;
    }
    next();
  });
  app.use('/api/auth', createAuthRouter());
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    response.status(status).json({ error: { code: (error as { code?: string }).code } });
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function beginSlackOAuth(origin: string) {
  const response = await fetch(`${origin}/api/auth/slack`, {
    headers: { 'x-test-auth': 'yes' },
    redirect: 'manual',
  });
  return {
    response,
    cookie: response.headers.get('set-cookie')!.split(';', 1)[0],
    state: new URL(response.headers.get('location')!).searchParams.get('state')!,
  };
}

function slackOAuthResponse() {
  return new Response(JSON.stringify({
    ok: true,
    team: { id: 'T123', name: 'Test Team' },
    incoming_webhook: { url: webhookUrl, channel: 'alerts', channel_id: 'C123' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Slack OAuth and credential security', () => {
  it('accepts session-bound OAuth state and persists only an encrypted webhook', async () => {
    const origin = await startSlackAuthServer();
    const initiated = await beginSlackOAuth(origin);
    const authorization = new URL(initiated.response.headers.get('location')!);
    expect(authorization.origin + authorization.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(authorization.searchParams.get('scope')).toBe('incoming-webhook');
    expect(authorization.searchParams.get('state')).toBe(initiated.state);

    const fetchMock = vi.fn().mockResolvedValue(slackOAuthResponse());
    vi.stubGlobal('fetch', fetchMock);
    const callback = await requestFetch(`${origin}/api/auth/slack/callback?code=slack-code&state=${initiated.state}`, {
      headers: { Cookie: initiated.cookie, 'x-test-auth': 'yes' },
      redirect: 'manual',
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('slack=connected');
    expect(fetchMock).toHaveBeenCalledOnce();
    const saved = mocks.upsert.mock.calls[0]![0];
    const encrypted = saved.create;
    expect(encrypted.webhookCiphertext).not.toContain(webhookUrl);
    expect(decryptSecret({
      ciphertext: encrypted.webhookCiphertext,
      nonce: encrypted.webhookNonce,
      authTag: encrypted.webhookAuthTag,
    })).toBe(webhookUrl);
    expect(callback.headers.get('location')).not.toContain(webhookUrl);
  });

  it.each([
    ['missing state', ''],
    ['invalid state', 'invalid-state-value'],
  ])('rejects %s', async (_name, state) => {
    const origin = await startSlackAuthServer();
    const initiated = await beginSlackOAuth(origin);
    const stateQuery = state ? `&state=${state}` : '';
    const callback = await fetch(`${origin}/api/auth/slack/callback?code=slack-code${stateQuery}`, {
      headers: { Cookie: initiated.cookie, 'x-test-auth': 'yes' },
    });
    expect(callback.status).toBe(400);
    expect((await callback.json()).error.code).toBe('SLACK_STATE_INVALID');
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects replayed valid state without making a second Slack token request', async () => {
    const origin = await startSlackAuthServer();
    const initiated = await beginSlackOAuth(origin);
    const fetchMock = vi.fn().mockResolvedValue(slackOAuthResponse());
    vi.stubGlobal('fetch', fetchMock);
    const url = `${origin}/api/auth/slack/callback?code=slack-code&state=${initiated.state}`;
    const first = await requestFetch(url, { headers: { Cookie: initiated.cookie, 'x-test-auth': 'yes' }, redirect: 'manual' });
    const replay = await requestFetch(url, { headers: { Cookie: initiated.cookie, 'x-test-auth': 'yes' }, redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(replay.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });

  it('rejects an unsuccessful Slack token-exchange HTTP response', async () => {
    const origin = await startSlackAuthServer();
    const initiated = await beginSlackOAuth(origin);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    const callback = await requestFetch(`${origin}/api/auth/slack/callback?code=slack-code&state=${initiated.state}`, {
      headers: { Cookie: initiated.cookie, 'x-test-auth': 'yes' },
    });
    expect(callback.status).toBe(502);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('encrypts credentials with authenticated AES-GCM ciphertext', () => {
    const encrypted = encryptSecret(webhookUrl);
    expect(encrypted.ciphertext).not.toBe(webhookUrl);
    expect(encrypted.nonce).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();
    expect(decryptSecret(encrypted)).toBe(webhookUrl);
  });
});

describe('Slack hourly-cap notifications', () => {
  const encrypted = encryptSecret(webhookUrl);
  const installation = {
    webhookCiphertext: encrypted.ciphertext,
    webhookNonce: encrypted.nonce,
    webhookAuthTag: encrypted.authTag,
    channelName: 'alerts',
  };

  beforeEach(() => {
    mocks.findUnique.mockResolvedValue(installation);
  });

  it('sends the cap notification to the configured webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await notifySenderCap('sender-1', 'owner-1');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(webhookUrl);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ text: expect.stringContaining('Channel: alerts') });
  });

  it('treats non-2xx responses as failures and retries only a bounded number of times', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rejected', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await notifySenderCap('sender-http', 'owner-http');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.warn).toHaveBeenCalled();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(webhookUrl);
  });

  it('contains network and timeout failures and stops after bounded retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error(`failed for ${webhookUrl}`), { name: 'TimeoutError' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(notifySenderCap('sender-timeout', 'owner-timeout')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(webhookUrl);
  });

  it('contains ordinary network failures without exposing webhook details in logs', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`network failure for ${webhookUrl}`));
    vi.stubGlobal('fetch', fetchMock);
    await expect(notifySenderCap('sender-network', 'owner-network')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(webhookUrl);
  });

  it('sends at most one notification for concurrent cap hits in the same sender-hour', async () => {
    let claimed = false;
    mocks.redisSet.mockImplementation(async () => {
      if (claimed) return null;
      claimed = true;
      return 'OK';
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([
      notifySenderCap('sender-concurrent', 'owner-concurrent'),
      notifySenderCap('sender-concurrent', 'owner-concurrent'),
    ]);
    expect(mocks.redisSet).toHaveBeenCalledTimes(2);
    expect(mocks.redisSet.mock.calls[0]![0]).toBe(mocks.redisSet.mock.calls[1]![0]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not throw when deduplication storage is unavailable', async () => {
    mocks.redisSet.mockRejectedValue(new Error('Redis unavailable'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(notifySenderCap('sender-redis-down', 'owner-redis-down')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
