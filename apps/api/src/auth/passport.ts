import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { config } from '../config.js';
import { prisma } from '../database.js';

if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  passport.use('google', new GoogleStrategy({
    clientID: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    callbackURL: config.GOOGLE_CALLBACK_URL,
    state: true,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) {
        done(new Error('Google did not return an email address.'));
        return;
      }

      const user = await prisma.user.upsert({
        where: { googleSubject: profile.id },
        create: {
          googleSubject: profile.id,
          email: email.toLowerCase(),
          name: profile.displayName || email,
          avatarUrl: profile.photos?.[0]?.value ?? null,
        },
        update: {
          email: email.toLowerCase(),
          name: profile.displayName || email,
          avatarUrl: profile.photos?.[0]?.value ?? null,
        },
        select: { id: true, email: true, name: true, avatarUrl: true },
      });
      done(null, user);
    } catch (error) {
      done(error as Error);
    }
  }));
}

passport.serializeUser((user: { id: string }, done) => done(null, user.id));
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, avatarUrl: true },
    });
    done(null, user ?? false);
  } catch (error) {
    done(error as Error);
  }
});

export { passport };
