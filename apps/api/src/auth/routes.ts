import { Router } from 'express';
import type { RequestHandler } from 'express';
import 'express-session';
import passport from 'passport';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { prisma } from '../database.js';
import { encryptSecret } from '../security/secrets.js';
import { requireUser } from './require-user.js';

const requireGoogleConfiguration: RequestHandler = (_request, _response, next) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    next(new AppError(503, 'GOOGLE_OAUTH_UNAVAILABLE', 'Google OAuth is not configured on this server.'));
    return;
  }
  next();
};

export function createAuthRouter() {
  const router = Router();

  router.get('/google', requireGoogleConfiguration, passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  }));

  router.get('/google/callback', requireGoogleConfiguration, passport.authenticate('google', {
    failureRedirect: `${config.WEB_ORIGIN}/?authError=google`,
  }), (_request, response) => {
    response.redirect(`${config.WEB_ORIGIN}/dashboard`);
  });

  router.get('/slack', requireUser, (request, response, next) => {
    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
      next(new AppError(503, 'SLACK_OAUTH_UNAVAILABLE', 'Slack OAuth is not configured on this server.'));
      return;
    }
    const state = randomBytes(18).toString('hex');
    const authUrl = new URL('https://slack.com/oauth/v2/authorize');
    authUrl.searchParams.set('client_id', config.SLACK_CLIENT_ID);
    authUrl.searchParams.set('scope', 'incoming-webhook');
    authUrl.searchParams.set('user_scope', '');
    authUrl.searchParams.set('redirect_uri', config.SLACK_CALLBACK_URL);
    authUrl.searchParams.set('state', state);
    request.session.slackOAuthState = state;
    response.redirect(authUrl.toString());
  });

  router.get('/slack/callback', async (request, response, next) => {
    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
      next(new AppError(503, 'SLACK_OAUTH_UNAVAILABLE', 'Slack OAuth is not configured on this server.'));
      return;
    }

    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!code) {
      next(new AppError(400, 'SLACK_CALLBACK_INVALID', 'Slack returned an invalid OAuth callback.'));
      return;
    }

    const state = typeof request.query.state === 'string' ? request.query.state : '';
    if (!state || !request.session.slackOAuthState || state !== request.session.slackOAuthState) {
      next(new AppError(400, 'SLACK_STATE_INVALID', 'Slack OAuth state validation failed.'));
      return;
    }
    delete request.session.slackOAuthState;

    if (!request.isAuthenticated() || !request.user) {
      response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
      return;
    }

    try {
      const payload = new URLSearchParams({
        code,
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        redirect_uri: config.SLACK_CALLBACK_URL,
      });
      const oauthResponse = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!oauthResponse.ok) {
        throw new AppError(502, 'SLACK_TOKEN_EXCHANGE_FAILED', 'Slack OAuth token exchange failed.');
      }
      const data = await oauthResponse.json() as {
        ok?: boolean;
        error?: string;
        team?: { id?: string; name?: string };
        incoming_webhook?: { url?: string; channel?: string; channel_id?: string };
      };
      if (!data.ok || !data.incoming_webhook?.url) {
        throw new AppError(400, 'SLACK_INSTALL_FAILED', data.error ? `Slack installation failed: ${data.error}` : 'Slack installation failed.');
      }

      const encrypted = encryptSecret(data.incoming_webhook.url);
      await prisma.slackInstallation.upsert({
        where: { ownerId: request.user.id },
        update: {
          teamId: data.team?.id ?? null,
          teamName: data.team?.name ?? null,
          channelId: data.incoming_webhook.channel_id ?? null,
          channelName: data.incoming_webhook.channel ?? null,
          webhookCiphertext: encrypted.ciphertext,
          webhookNonce: encrypted.nonce,
          webhookAuthTag: encrypted.authTag,
        },
        create: {
          ownerId: request.user.id,
          teamId: data.team?.id ?? null,
          teamName: data.team?.name ?? null,
          channelId: data.incoming_webhook.channel_id ?? null,
          channelName: data.incoming_webhook.channel ?? null,
          webhookCiphertext: encrypted.ciphertext,
          webhookNonce: encrypted.nonce,
          webhookAuthTag: encrypted.authTag,
        },
      });

      response.redirect(`${config.WEB_ORIGIN}/dashboard?slack=connected`);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/slack', async (request, response) => {
    if (!request.isAuthenticated() || !request.user) {
      response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
      return;
    }

    await prisma.slackInstallation.deleteMany({ where: { ownerId: request.user.id } });
    response.status(204).end();
  });

  router.get('/me', (request, response) => {
    if (!request.user) {
      response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
      return;
    }
    response.json({ user: request.user });
  });

  router.post('/logout', (request, response, next) => {
    request.logout((logoutError) => {
      if (logoutError) {
        next(logoutError);
        return;
      }
      request.session.destroy((sessionError) => {
        if (sessionError) {
          next(sessionError);
          return;
        }
        response.clearCookie('reachinbox.sid', {
          httpOnly: true,
          sameSite: 'lax',
          secure: config.NODE_ENV === 'production',
          path: '/',
        });
        response.status(204).end();
      });
    });
  });

  return router;
}
