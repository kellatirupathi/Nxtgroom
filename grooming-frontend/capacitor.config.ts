import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Wraps the live site in an Android shell. The app opens the deployed site,
 * which talks to the same Northflank API over HTTPS. No database or credential
 * ships in the APK.
 */
const config: CapacitorConfig = {
  appId: 'in.nxtwave.facultytrack',
  appName: 'FacultyTrack',
  // Only what the APK itself needs: the page shown when the site cannot be
  // opened. The web bundle is not packaged - the app never loads a local copy,
  // so one would only be a stale build taking up space.
  webDir: 'android-shell',
  server: {
    androidScheme: 'https',
    // The app loads the deployed site rather than assets bundled into the
    // APK. Every Vercel deploy therefore reaches users immediately, with no
    // rebuild and nothing for them to reinstall — the same update story as the
    // website. The trade is that the app needs a connection, which it already
    // did: there is no local database to fall back on.
    url: 'https://nxtgroom-xi.vercel.app',
    cleartext: false,
    // Served from inside the APK when the site cannot load - no connection, or
    // a WebView older than minWebViewVersion - instead of Chrome's error page,
    // which shows the raw address and no way back.
    errorPath: 'offline.html',
  },
  android: {
    // The check-in photo is uploaded, never dragged in from elsewhere.
    allowMixedContent: false,
    // The oldest WebView the site runs in: Tailwind 4's CSS needs Chrome 111.
    // Older devices are shown how to update instead of a broken page. Keep in
    // step with MIN_VERSION in android-shell/offline.html.
    minWebViewVersion: 111,
  },
};

export default config;
