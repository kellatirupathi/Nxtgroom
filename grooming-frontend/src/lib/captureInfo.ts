import type { CaptureInfo } from './bodyRegions.ts';
import type { CapturedPhoto } from './stillCapture.ts';

type SettingsTrack = { getSettings?: () => MediaTrackSettings } | null;

const text = (value: unknown, max = 60) => (value === undefined || value === null ? undefined : String(value).slice(0, max));

export function deviceModel(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const android = /Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(userAgent);
  if (android) return `Android: ${android[1].trim()}`.slice(0, 80);
  return userAgent.slice(0, 80);
}

export function describeCapture(photo: CapturedPhoto, track: SettingsTrack, userAgent = globalThis.navigator?.userAgent): CaptureInfo | null {
  const diagnostics = photo.diagnostics;
  if (!diagnostics) return null;
  let settings: (MediaTrackSettings & Record<string, unknown>) | undefined;
  try {
    settings = track?.getSettings?.() as (MediaTrackSettings & Record<string, unknown>) | undefined;
  } catch {
    settings = undefined;
  }
  const camera = settings
    ? {
        width: settings.width,
        height: settings.height,
        frameRate: typeof settings.frameRate === 'number' ? Math.round(settings.frameRate) : undefined,
        facingMode: text(settings.facingMode, 20),
        focusMode: text(settings.focusMode, 20),
      }
    : undefined;
  return {
    source: diagnostics.source,
    video: diagnostics.video,
    region: diagnostics.region,
    output: diagnostics.output,
    bytes: photo.blob.size,
    still: { ...diagnostics.still },
    ...(camera ? { camera } : {}),
    device: deviceModel(userAgent),
  };
}
