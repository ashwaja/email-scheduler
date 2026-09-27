import type { RequestHandler } from 'express';

export const requireUser: RequestHandler = (request, response, next) => {
  if (!request.isAuthenticated() || !request.user) {
    response.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    return;
  }
  next();
};
