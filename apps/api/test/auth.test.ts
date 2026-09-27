import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.GOOGLE_CLIENT_ID ||= 'oauth-test-client-id';
process.env.GOOGLE_CLIENT_SECRET ||= 'oauth-test-client-secret';

const [{ createAuthRouter }, { passport }] = await Promise.all([
  import('../src/auth/routes.js'),
  import('../src/auth/passport.js'),
]);

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
  vi.restoreAllMocks();
});

async function startAuthServer() {
  const app = express();
  app.use(session({
    name: 'reachinbox.sid',
    secret: 'auth-test-session-secret-that-is-long-enough',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false },
  }));
  app.use(passport.initialize());
  app.use(passport.session());
  app.use((request, _response, next) => {
    if (request.get('x-test-auth') === 'yes') {
      request.user = {
        id: 'test-user-id',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
      };
    }
    next();
  });
  app.use('/api/auth', createAuthRouter());
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(500).end();
  });

  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function sessionCookie(response: Response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0];
}

describe('authentication routes', () => {
  it('rejects unauthenticated /me requests', async () => {
    const origin = await startAuthServer();
    const response = await fetch(`${origin}/api/auth/me`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('returns the authenticated profile from /me', async () => {
    const origin = await startAuthServer();
    const response = await fetch(`${origin}/api/auth/me`, {
      headers: { 'x-test-auth': 'yes' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        id: 'test-user-id',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
      },
    });
  });

  it('logs out and clears the session cookie', async () => {
    const origin = await startAuthServer();
    const response = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('reachinbox.sid=');
    expect(response.headers.get('set-cookie')).toContain('Expires=');
  });

  it('generates session-bound state and accepts it only once', async () => {
    const origin = await startAuthServer();
    const initiated = await fetch(`${origin}/api/auth/google`, { redirect: 'manual' });
    const cookie = sessionCookie(initiated);
    const authorizationUrl = new URL(initiated.headers.get('location')!);
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(cookie).toBeTruthy();

    const strategy = passport._strategy('google') as unknown as {
      _oauth2: { getOAuthAccessToken: (...args: unknown[]) => unknown };
    };
    const tokenExchange = vi.spyOn(strategy._oauth2, 'getOAuthAccessToken').mockImplementation((...args) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(new Error('Stop before contacting Google in this test.'));
    });

    const callbackResponse = await fetch(
      `${origin}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state!)}`,
      { headers: { Cookie: cookie! }, redirect: 'manual' },
    );
    expect(tokenExchange).toHaveBeenCalledOnce();
    expect(callbackResponse.status).toBe(500);

    const replayResponse = await fetch(
      `${origin}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state!)}`,
      { headers: { Cookie: cookie! }, redirect: 'manual' },
    );
    expect(tokenExchange).toHaveBeenCalledOnce();
    expect(replayResponse.status).toBe(302);
    expect(replayResponse.headers.get('location')).toContain('authError=google');
  });

  it.each([
    ['missing', ''],
    ['invalid', 'not-the-session-state'],
  ])('rejects %s Google OAuth state', async (_description, state) => {
    const origin = await startAuthServer();
    const initiated = await fetch(`${origin}/api/auth/google`, { redirect: 'manual' });
    const cookie = sessionCookie(initiated)!;
    const stateQuery = state ? `&state=${encodeURIComponent(state)}` : '';
    const response = await fetch(
      `${origin}/api/auth/google/callback?code=test-code${stateQuery}`,
      { headers: { Cookie: cookie }, redirect: 'manual' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('authError=google');
  });
});