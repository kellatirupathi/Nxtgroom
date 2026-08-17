import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Wraps the existing web build in an Android shell. No React code changes:
 * the same bundle Vercel serves is copied into the app and talks to the same
 * Northflank API over HTTPS. No database or credential ships in the APK.
 */
const config: CapacitorConfig = {
  appId: 'in.nxtwave.facultytrack',
  appName: 'FacultyTrack',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // The app loads the deployed site rather than assets bundled into the
    // APK. Every Vercel deploy therefore reaches users immediately, with no
    // rebuild and nothing for them to reinstall — the same update story as the
    // website. The trade is that the app needs a connection, which it already
    // did: there is no local database to fall back on.
    url: 'https://nxtgroom-xi.vercel.app',
    cleartext: false,
  },
  android: {
    // The check-in photo is uploaded, never dragged in from elsewhere.
    allowMixedContent: false,
  },
};

export default config;
