import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.nxtwave.facultytrack',
  appName: 'FacultyTrack',
  webDir: 'android-shell',
  server: {
    androidScheme: 'https',
    url: 'https://nxtgroom-xi.vercel.app',
    cleartext: false,
    errorPath: 'offline.html',
  },
  android: {
    allowMixedContent: false,
    minWebViewVersion: 111,
  },
};

export default config;
