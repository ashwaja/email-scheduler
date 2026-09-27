import 'passport';
import 'express-serve-static-core';
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    slackOAuthState?: string;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
    }
  }
}
