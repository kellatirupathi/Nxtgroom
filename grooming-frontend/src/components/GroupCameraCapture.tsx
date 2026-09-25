import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, SwitchCamera, Users } from 'lucide-react';
import {
  GROUP_CAPTURE_CONFIRMATIONS,
  GROUP_MAX_PEOPLE,
  groupCaptureReady,
  groupFallbackDue,
  groupShutterEnabled,
  INITIAL_GROUP_STATE,
  readGroupFrame,
  stabilizeGroupReading,
  type GroupReading,
  type GroupVerdict,
  type StableGroupState,
} from '../lib/groupFrameDetector';
import { loadFullBodyDetector, AUTO_CAPTURE_COOLDOWN_MS } from '../lib/fullBodyDetector';
import FaceBoxOverlay from './FaceBoxOverlay';
import { stabilizeBoxLabels, withoutLabels, type FaceBox, type LabelMemory } from '../lib/faceBoxes';
import { coverSourceRect } from '../lib/cameraGeometry';
import { openCameraStream } from '../lib/cameraStream';
import { capturePhoto, createStillCaptureState, GROUP_UPLOAD_MAX_DIMENSION } from '../lib/stillCapture';

/**
 * A viewfinder for photographing several people at once.
 *
 * Deliberately a separate component from CameraCapture rather than a mode on
 * it. That one is the camera every college's attendance currently runs
 * through, and the differences here are not a flag or two: the frame is
 * measured by a different gate, saved without the standing outline's crop, and
 * described to the people in front of it in different words. Threading all of
 * that through the working component as branches would put the group's
 * behaviour inside the single person's code path, which is the one place it
 * must never be.
 *
 * The cost is honest duplication — the stream plumbing below is the same
 * plumbing, and a fix to one will need making in the other. That is the price
 * of leaving the working screen untouched, and it is the right way round while
 * this is new.
 */

interface GroupCameraCaptureProps {
  facing: 'user' | 'environment';
  onFlip: () => void;
  onCapture: (file: File) => void | Promise<void>;
}

/** Failure modes worth telling apart: the fix differs for each. */
function describeCameraError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access is blocked. Allow the camera in your settings, then reopen this screen.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is already in use by another app. Close it and try again.';
  }
  return 'The camera could not be started. Check permissions and try again.';
}

export default function GroupCameraCapture({ facing, onFlip, onCapture }: GroupCameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [reading, setReading] = useState<GroupReading>(INITIAL_GROUP_STATE.reading);
  const [steadyFrames, setSteadyFrames] = useState(0);
  const [manualOffered, setManualOffered] = useState(false);
  /**
   * A box per face, from the raw reading rather than the stabilised one.
   *
   * The verdict is held steady so the guidance does not flicker; the boxes are
   * not, because a box lagging the face it belongs to is worse than a box that
   * is briefly wrong, and nothing depends on them.
   */
  const [faceBoxes, setFaceBoxes] = useState<FaceBox[]>([]);

  // All read by the inspection loop on every tick, so they are refs: as state
  // they would be captured stale by the running timer and the camera would fire
  // during its own cooldown.
  const cooldownUntilRef = useRef(0);
  const firingRef = useRef(false);
  const verdictRef = useRef<GroupVerdict>('NO_PEOPLE');
  const steadyRef = useRef(0);
  const unusableRef = useRef(0);
  const manualOfferedRef = useRef(false);
  const shootRef = useRef<(options?: { viaAuto?: boolean }) => Promise<void>>(async () => {});
  /** What each chip said last; see stabilizeBoxLabels. */
  const labelMemoryRef = useRef<LabelMemory>({});
  /** What this camera's still photographs can do; see stillCapture. */
  const stillStateRef = useRef(createStillCaptureState());
  /** True while the camera is being opened, so a wake-up does not open it twice. */
  const openingRef = useRef(false);
  /** Bumped to reopen the camera after the screen was hidden. */
  const [streamGeneration, setStreamGeneration] = useState(0);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    setStarting(true);
    setError('');
    setReading(INITIAL_GROUP_STATE.reading);

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot open the camera. Use a recent Chrome, Safari, or Edge.');
        setStarting(false);
        return;
      }
      openingRef.current = true;
      try {
        // The preview only needs 1080p; the photograph itself is taken as a
        // full-resolution still where the device allows - see stillCapture.
        // Retried while the camera is busy, because the one-person screen may
        // have let go of it only a moment ago - see openCameraStream.
        const stream = await openCameraStream({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        }, { isCancelled: () => disposed });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (startError) {
        if (!disposed) setError(describeCameraError(startError));
      } finally {
        openingRef.current = false;
        if (!disposed) setStarting(false);
      }
    };

    void start();
    return () => {
      disposed = true;
      stop();
    };
  }, [facing, stop, streamGeneration]);

  /** Watches the live frame for a group standing still and facing this way. */
  useEffect(() => {
    if (error) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const detectorGraceTimer = setTimeout(() => {
      if (!disposed) {
        setReading({ verdict: 'UNAVAILABLE', guidance: null, people: 0, faces: 0 });
        setManualOffered(true);
        manualOfferedRef.current = true;
      }
    }, 4_000);
    let stableState: StableGroupState = INITIAL_GROUP_STATE;

    const inspect = async () => {
      const detector = await loadFullBodyDetector();
      clearTimeout(detectorGraceTimer);
      const tick = async () => {
        if (disposed) return;
        const video = videoRef.current;
        const viewport = viewportRef.current;
        const next: GroupReading = video
          ? await readGroupFrame(detector, video, viewport ? {
              width: viewport.clientWidth,
              height: viewport.clientHeight,
              canvas: analysisCanvasRef.current ||= document.createElement('canvas'),
            } : undefined, { mirrored: facing === 'user' })
          : { verdict: 'UNAVAILABLE', guidance: null, people: 0, faces: 0, boxes: [] };
        if (disposed) return;

        stableState = stabilizeGroupReading(stableState, next);
        const stable = stableState.reading;
        setReading(stable);
        verdictRef.current = stable.verdict;
        // Positions follow the live reading; the chips do not. A chip built
        // from a threshold would flip on every tick as an ankle score wandered
        // across it, so a label must be seen three times before it changes.
        // And once the group is ready no chip is shown at all: an instruction
        // under a face the countdown is running for is a contradiction.
        const labelled = stabilizeBoxLabels(labelMemoryRef.current, next.boxes ?? []);
        labelMemoryRef.current = labelled.memory;
        setFaceBoxes(stable.verdict === 'GROUP_READY' ? withoutLabels(labelled.boxes) : labelled.boxes);

        const fireable = stable.verdict === 'GROUP_READY';
        const held = fireable ? steadyRef.current + 1 : 0;
        steadyRef.current = held;
        setSteadyFrames(held);

        unusableRef.current = fireable ? 0 : unusableRef.current + 1;
        if (!manualOfferedRef.current && groupFallbackDue(unusableRef.current)) {
          manualOfferedRef.current = true;
          setManualOffered(true);
        }

        if (
          groupCaptureReady(stable.verdict, held)
          && Date.now() >= cooldownUntilRef.current
          && !firingRef.current
        ) {
          void shootRef.current({ viaAuto: true });
        }
        timer = setTimeout(tick, 200);
      };
      void tick();
    };
    void inspect();

    return () => {
      disposed = true;
      clearTimeout(detectorGraceTimer);
      clearTimeout(timer);
    };
  }, [error, facing]);

  // A held stream keeps the camera indicator on and blocks other apps. Coming
  // back, the camera is opened again - unless an opening is already under way.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else if (!streamRef.current && !openingRef.current) {
        setStreamGeneration((generation) => generation + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stop]);

  const ready = groupShutterEnabled(reading.verdict);

  const shoot = useCallback(async ({ viaAuto = false } = {}) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    if (!viaAuto && !groupShutterEnabled(verdictRef.current)) return;
    if (firingRef.current) return;
    firingRef.current = true;
    setCapturing(true);
    try {
      const viewport = viewportRef.current;
      /**
       * The whole visible preview, not the standing outline.
       *
       * The single-person camera crops to a tall narrow guide, which is right
       * for one person filling it and would cut the people at both ends off a
       * group. Everybody who was in the picture has to be in the photograph, or
       * they are photographed and never recorded.
       */
      const crop = coverSourceRect(
        video.videoWidth,
        video.videoHeight,
        viewport?.clientWidth || video.videoWidth,
        viewport?.clientHeight || video.videoHeight,
      );
      // Taken from the camera's full-resolution still where the device can,
      // at up to 3072 on the long side: a group spends its pixels on several
      // faces. The video frame otherwise. Unmirrored either way, or text on a
      // lanyard reads backwards. Quality a notch under the single camera's,
      // because this photograph is several times larger to upload.
      const photo = await capturePhoto({
        video,
        track: streamRef.current?.getVideoTracks()[0] ?? null,
        region: crop,
        maxDimension: GROUP_UPLOAD_MAX_DIMENSION,
        quality: 0.9,
        state: stillStateRef.current,
      });
      // The shutter stays locked until the whole group has been identified,
      // recorded and answered for, so a slow request cannot fire a second frame.
      await onCapture(new File([photo.blob], `group-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    } catch {
      setError('The photo could not be captured. Try again.');
    } finally {
      setCapturing(false);
      firingRef.current = false;
      cooldownUntilRef.current = Date.now() + AUTO_CAPTURE_COOLDOWN_MS;
      setSteadyFrames(0);
      steadyRef.current = 0;
    }
  }, [onCapture]);

  useEffect(() => {
    shootRef.current = shoot;
  }, [shoot]);

  const countLabel = reading.people > 0
    ? `${reading.people} ${reading.people === 1 ? 'person' : 'people'}`
    : null;

  return (
    <div className="absolute inset-0 bg-black flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        {/* How many people the camera can currently see. In a group this is the
            thing somebody arranging people actually needs to know, and it is
            the only way to notice that the person at the end is not being
            detected before the photograph is taken rather than after. */}
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Users size={18} aria-hidden="true" />
          <span aria-live="polite">{countLabel || 'Nobody in frame'}</span>
        </p>
        <button
          type="button"
          onClick={onFlip}
          aria-label={facing === 'user' ? 'Switch to back camera' : 'Switch to front camera'}
          className="w-11 h-11 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"
        >
          <SwitchCamera size={22} aria-hidden="true" />
        </button>
      </div>

      <div ref={viewportRef} className="flex-1 relative overflow-hidden">
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8" role="alert">
            <Camera size={40} className="text-white/40 mb-4" aria-hidden="true" />
            <p className="text-sm font-medium text-white/90 leading-relaxed">{error}</p>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 w-full h-full object-cover"
              style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined }}
            />

            {/* A box on every face the camera has found: green on a face it
                could identify, amber on one turned away, and a chip under
                anyone with something to fix. This is what makes "2 people are
                not fully in frame" usable: the message says how many and the
                chips say which. */}
            {!starting && <FaceBoxOverlay boxes={faceBoxes} />}

            {/* A border rather than a standing outline: the whole frame is the
                photograph here, so what it shows is the edge of what will be
                kept. Green once the group is ready to be photographed. */}
            {!starting && (
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-2 rounded-lg border-2 transition-colors ${
                  reading.verdict === 'GROUP_READY'
                    ? 'border-emerald-400/90'
                    : reading.verdict === 'TOO_MANY'
                      ? 'border-rose-400/95'
                      : 'border-white/40'
                }`}
              />
            )}

            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 px-6">
              {reading.guidance ? (
                <p className="rounded-full bg-slate-900/75 px-4 py-2 text-center text-sm font-semibold text-white" role="status">
                  {reading.guidance}
                </p>
              ) : capturing || (steadyFrames > 0 && steadyFrames < GROUP_CAPTURE_CONFIRMATIONS) ? (
                <p className="rounded-full bg-emerald-500/90 px-4 py-2 text-sm font-bold text-white" role="status">
                  Everybody hold still…
                </p>
              ) : (
                <p className="rounded-full bg-slate-900/75 px-4 py-2 text-center text-sm font-semibold text-white" role="status">
                  Stand together facing the camera — up to {GROUP_MAX_PEOPLE} people
                </p>
              )}

              {manualOffered && (
                <p className="rounded-xl bg-amber-500/95 px-4 py-2 text-center text-xs font-semibold text-white max-w-xs" role="status">
                  Everybody should face the camera with their whole body visible,
                  or use the button below.
                </p>
              )}
            </div>

            {starting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black" role="status">
                <RefreshCw size={28} className="animate-spin text-white/60" aria-hidden="true" />
              </div>
            )}
          </>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-6 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={() => void shoot()}
          hidden={!manualOffered}
          disabled={Boolean(error) || starting || capturing || !ready}
          aria-label={ready ? 'Photograph this group' : 'Position the group in the camera to take a photo'}
          className="w-[72px] h-[72px] rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform disabled:opacity-40 flex items-center justify-center pointer-events-auto shadow-lg"
        >
          {capturing ? (
            <RefreshCw size={26} className="animate-spin text-slate-700" aria-hidden="true" />
          ) : (
            <span className="w-14 h-14 rounded-full bg-white ring-2 ring-slate-900/10" />
          )}
        </button>
      </div>
    </div>
  );
}
