import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { androidAppBridge, downloadAttendanceCsv } from '../src/attendanceExport.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/**
 * The Android app: a Capacitor shell around the live site.
 *
 * The native half cannot run here, so these tests hold the two halves to the
 * names and numbers they share - the plugin the page calls, the WebView
 * version the offline page quotes, the page Capacitor shows on an error - and
 * keep the release key out of git.
 */

const android = (platform = 'android', calls = []) => ({
  getPlatform: () => platform,
  nativePromise: (plugin, method, options) => {
    calls.push({ plugin, method, options });
    return Promise.resolve({ savedTo: 'downloads' });
  },
});

test('the app is recognised by its injected bridge, and only on Android', () => {
  assert.ok(androidAppBridge({ Capacitor: android() }));
  assert.equal(androidAppBridge({}), null, 'the website has no bridge');
  assert.equal(androidAppBridge({ Capacitor: android('web') }), null);
  assert.equal(androidAppBridge({ Capacitor: { getPlatform: () => 'android' } }), null, 'no native calls, no bridge');
});

test('inside the app, Export hands the CSV to the native file saver', async () => {
  const calls = [];
  globalThis.Capacitor = android('android', calls);
  try {
    await downloadAttendanceCsv(
      [{ _id: '1', instructor_name: 'Asha', status: 'compliant' }],
      { from: '2026-09-26', to: '2026-09-26' },
    );
  } finally {
    delete globalThis.Capacitor;
  }
  assert.equal(calls.length, 1);
  const [{ plugin, method, options }] = calls;
  assert.equal(plugin, 'FileSaver');
  assert.equal(method, 'saveText');
  assert.equal(options.fileName, 'daily-attendance-2026-09-26.csv');
  assert.equal(options.mimeType, 'text/csv');
  assert.ok(options.content.startsWith('﻿Instructor Name,'), 'the same file as the browser download, BOM included');
  assert.match(options.content, /\r\nAsha,/);
});

test('a failed save reaches the Export button, which reports it', async () => {
  globalThis.Capacitor = { getPlatform: () => 'android', nativePromise: () => Promise.reject(new Error('FileSaver not implemented')) };
  try {
    await assert.rejects(downloadAttendanceCsv([], { from: '', to: '' }), /not implemented/);
  } finally {
    delete globalThis.Capacitor;
  }
  const table = read('src/components/DailyAttendanceTable.tsx');
  assert.match(table, /downloadAttendanceCsv\(filteredRecords, range\)\.catch\(/);
  assert.match(table, /toast\.error\('Could not export the records'/);
});

test('the native plugin is registered under the name the page calls', () => {
  const plugin = read('android/app/src/main/java/in/nxtwave/facultytrack/FileSaverPlugin.java');
  assert.match(plugin, /@CapacitorPlugin\(name = "FileSaver"\)/);
  assert.match(plugin, /public void saveText\(PluginCall call\)/);
  const activity = read('android/app/src/main/java/in/nxtwave/facultytrack/MainActivity.java');
  const register = activity.indexOf('registerPlugin(FileSaverPlugin.class)');
  assert.ok(register > 0 && register < activity.indexOf('super.onCreate(savedInstanceState);'), 'registered before the bridge is built');
  assert.match(activity, /webView\.canGoBack\(\)[\s\S]*webView\.goBack\(\)/, 'Back goes back a page');
});

test('the offline page ships in the APK and agrees on the WebView version', () => {
  const config = read('capacitor.config.ts');
  const webDir = /webDir: '([^']+)'/.exec(config)[1];
  const errorPath = /errorPath: '([^']+)'/.exec(config)[1];
  assert.ok(existsSync(new URL(`../${webDir}/${errorPath}`, import.meta.url)), 'the error page must be in webDir');
  assert.ok(existsSync(new URL(`../${webDir}/index.html`, import.meta.url)), 'Capacitor requires an index.html');
  const minVersion = Number(/minWebViewVersion: (\d+)/.exec(config)[1]);
  const pageVersion = Number(/var MIN_VERSION = (\d+);/.exec(read(`${webDir}/${errorPath}`))[1]);
  assert.equal(pageVersion, minVersion);
  assert.match(config, /url: 'https:\/\/nxtgroom-xi\.vercel\.app'/, 'the app opens the live site');
  const retryTarget = /var SITE = '([^']+)'/.exec(read(`${webDir}/${errorPath}`))[1];
  assert.equal(retryTarget, 'https://nxtgroom-xi.vercel.app/', 'Try again goes to the same site');
});

test('release builds are signed from a key that never enters git', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /rootProject\.file\('keystore\.properties'\)/);
  assert.match(gradle, /signingConfig signingConfigs\.release/);
  const ignore = read('android/.gitignore').split(/\r?\n/);
  for (const pattern of ['keystore.properties', '*.jks', '*.keystore']) {
    assert.ok(ignore.includes(pattern), `${pattern} must be ignored`);
  }
  const versionCode = Number(/versionCode (\d+)/.exec(gradle)[1]);
  assert.ok(versionCode >= 4, 'each release must raise versionCode, or devices refuse the update');
});
