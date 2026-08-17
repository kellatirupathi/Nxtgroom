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
    // Served over https rather than the default http, so the WebView treats
    // the app as a secure context. Geolocation and the camera both require
    // one, and they are the two features this app depends on most.
    androidScheme: 'https',
  },
  android: {
    // The check-in photo is uploaded, never dragged in from elsewhere.
    allowMixedContent: false,
  },
};

export default config;
