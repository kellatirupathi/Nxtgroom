import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, SwitchCamera, X } from 'lucide-react';
import {
  AUTO_CAPTURE_COOLDOWN_MS,
  autoCaptureFallbackDue,
  autoCaptureReady,
  captureConfirmationCount,
  DETECTOR_STARTING_GUIDANCE,
  fullBodyDetectorSettled,
  loadFullBodyDetector,
  primeFullBodyDetector,
  readFrame,
  shutterEnabled,
  stabilizeFrameReading,
  type StableFrameState,
  type FrameReading,
  type FrameVerdict,
} from '../lib/fullBodyDetector';
import FaceBoxOverlay from './FaceBoxOverlay';
import type { FaceBox } from '../lib/faceBoxes';
import { bodyGuideSourceRect } from '../lib/cameraGeometry';
import { cameraVideoConstraints, openCameraStream, tuneCameraTrack } from '../lib/cameraStream';
import { capturePhoto, createStillCaptureState, SINGLE_UPLOAD_MAX_DIMENSION } from '../lib/stillCapture';
import type { BodyRegions, CaptureDetails } from '../lib/bodyRegions';
import { PHOTO_JPEG_QUALITY } from '../lib/photoEncoding';
import { postureHoldComplete, postureHoldStart } from '../lib/capturePosture';

type Facing = 'user' | 'environment';

interface CameraCaptureProps {
  facing: Facing;
  onFlip: () => void;
  onCapture: (file: File, details?: CaptureDetails) => void | Promise<void>;
  onClose: () => void;
  autoCapture?: boolean;
  inline?: boolean;
}

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

export default function CameraCapture({
  facing,
  onFlip,
  onCapture,
  onClose,
  autoCapture = false,
  inline = false,
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [verdict, setVerdict] = useState<FrameVerdict>('NO_PERSON');
  const [guidance, setGuidance] = useState<string | null>('Step into the frame');
  const [steadyFrames, setSteadyFrames] = useState(0);
  const [faceBoxes, setFaceBoxes] = useState<FaceBox[]>([]);
  const [manualOffered, setManualOffered] = useState(!autoCapture);
  const cooldownUntilRef = useRef(0);
  const firingRef = useRef(false);
  const verdictRef = useRef<FrameVerdict>('NO_PERSON');
  const bodyRegionsRef = useRef<BodyRegions | null>(null);
  const steadyRef = useRef(0);
  const postureSinceRef = useRef<number | null>(null);
  const unusableRef = useRef(0);
  const manualOfferedRef = useRef(!autoCapture);
  const shootRef = useRef<(options?: { viaAuto?: boolean }) => Promise<void>>(async () => {});
  const stillStateRef = useRef(createStillCaptureState());
  const openingRef = useRef(false);
  const [streamGeneration, setStreamGeneration] = useState(0);

  const stop = useCallback(() => {
    steadyRef.current = 0;
    postureSinceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    setStarting(true);
    setError('');
    setVerdict('NO_PERSON');
    setGuidance('Step into the frame');

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot open the camera. Use a recent Chrome, Safari, or Edge.');
        setStarting(false);
        return;
      }
      openingRef.current = true;
      try {
        const stream = await openCameraStream({
          video: cameraVideoConstraints(facing),
          audio: false,
        }, { isCancelled: () => disposed });
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        void tuneCameraTrack(stream.getVideoTracks()[0]);
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

  useEffect(() => {
    if (error) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const detectorGraceTimer = setTimeout(() => {
      if (!disposed) {
        setVerdict('UNAVAILABLE');
        setGuidance(null);
      }
    }, 4_000);
    let stableState: StableFrameState = {
      reading: { verdict: 'NO_PERSON', guidance: 'Step into the frame' },
      candidate: null,
      candidateCount: 0,
    };

    const inspect = async () => {
      if (!fullBodyDetectorSettled()) setGuidance(DETECTOR_STARTING_GUIDANCE);
      const detector = await loadFullBodyDetector();
      clearTimeout(detectorGraceTimer);
      const preview = viewportRef.current;
      if (preview) await primeFullBodyDetector(detector, preview.clientWidth, preview.clientHeight);
      const tick = async () => {
        if (disposed) return;
        const video = videoRef.current;
        const viewport = viewportRef.current;
        const reading: FrameReading = video
          ? await readFrame(detector, video, viewport ? {
              width: viewport.clientWidth,
              height: viewport.clientHeight,
              canvas: analysisCanvasRef.current ||= document.createElement('canvas'),
            } : undefined, { mirrored: facing === 'user' })
          : { verdict: 'UNAVAILABLE', guidance: null, boxes: [] };
        if (disposed) return;

        stableState = stabilizeFrameReading(stableState, reading);
        const stableReading = stableState.reading;
        setVerdict(stableReading.verdict);
        setGuidance(autoCapture && reading.verdict === 'FULL_BODY' && !reading.capturePosture?.ready
          ? reading.capturePosture?.guidance ?? 'Keep both arms and hands visible'
          : stableReading.guidance);
        verdictRef.current = stableReading.verdict;
        bodyRegionsRef.current = reading.verdict === 'FULL_BODY' ? (reading.bodyRegions ?? null) : null;
        setFaceBoxes(reading.boxes ?? []);

        if (autoCapture) {
          const fireable = stableReading.verdict === 'FULL_BODY'
            && reading.verdict === 'FULL_BODY' && reading.capturePosture?.ready === true;
          const now = Date.now();
          setCooldownSeconds(Math.max(0, Math.ceil((cooldownUntilRef.current - now) / 1000)));
          const held = captureConfirmationCount(fireable ? 'FULL_BODY' : 'PARTIAL', steadyRef.current, firingRef.current, cooldownUntilRef.current, now);
          postureSinceRef.current = postureHoldStart(held > 0, postureSinceRef.current, now);
          steadyRef.current = held;
          setSteadyFrames(held);

          unusableRef.current = fireable ? 0 : unusableRef.current + 1;
          if (!manualOfferedRef.current && autoCaptureFallbackDue(unusableRef.current)) {
            manualOfferedRef.current = true;
            setManualOffered(true);
          }

          if (
            autoCaptureReady(stableReading.verdict, held)
            && postureHoldComplete(postureSinceRef.current, now)
            && Date.now() >= cooldownUntilRef.current
            && !firingRef.current
          ) {
            void shootRef.current({ viaAuto: true });
          }
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
  }, [error, facing, autoCapture]);

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

  const ready = shutterEnabled(verdict, 0, false);

  const shoot = useCallback(async ({ viaAuto = false } = {}) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    if (!viaAuto && !shutterEnabled(verdictRef.current, 0, false)) return;
    if (firingRef.current) return;
    if (autoCapture && Date.now() < cooldownUntilRef.current) return;
    firingRef.current = true;
    setCapturing(true);
    try {
      const bodyRegions = bodyRegionsRef.current;
      const viewport = viewportRef.current;
      const crop = bodyGuideSourceRect(
        video.videoWidth,
        video.videoHeight,
        viewport?.clientWidth || video.videoWidth,
        viewport?.clientHeight || video.videoHeight,
      );
      const photo = await capturePhoto({
        video,
        track: streamRef.current?.getVideoTracks()[0] ?? null,
        region: crop,
        maxDimension: SINGLE_UPLOAD_MAX_DIMENSION,
        quality: PHOTO_JPEG_QUALITY,
        state: stillStateRef.current,
      });
      await onCapture(new File([photo.blob], `check-in-${Date.now()}.jpg`, { type: 'image/jpeg' }), { bodyRegions });
    } catch {
      setError('The photo could not be captured. Try again.');
    } finally {
      setCapturing(false);
      firingRef.current = false;
      cooldownUntilRef.current = autoCapture ? Date.now() + AUTO_CAPTURE_COOLDOWN_MS : 0;
      setCooldownSeconds(autoCapture ? AUTO_CAPTURE_COOLDOWN_MS / 1000 : 0);
      setSteadyFrames(0);
      steadyRef.current = 0;
      postureSinceRef.current = null;
    }
  }, [onCapture, autoCapture]);

  useEffect(() => {
    shootRef.current = shoot;
  }, [shoot]);

  return (
    <div
      className={inline
        ? 'absolute inset-0 bg-black flex flex-col'
        : 'fixed inset-0 z-[120] bg-black flex flex-col'}
      {...(inline ? {} : { role: 'dialog', 'aria-modal': true, 'aria-label': 'Take photo' })}
    >
      {!inline && <div
        className="flex items-center justify-between px-4 py-3 text-white"
        style={inline ? undefined : { paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        {!inline && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close camera"
            className="w-11 h-11 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"
          >
            <X size={22} aria-hidden="true" />
          </button>
        )}
        {!inline && <p className="text-sm font-semibold">Take photo</p>}
        <button
          type="button"
          onClick={onFlip}
          aria-label={facing === 'user' ? 'Switch to back camera' : 'Switch to front camera'}
          className={`w-11 h-11 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center${inline ? ' ml-auto' : ''}`}
        >
          <SwitchCamera size={22} aria-hidden="true" />
        </button>
      </div>}

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
            {!starting && <FaceBoxOverlay boxes={faceBoxes} />}

            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex flex-col items-center gap-2 px-6">
              {autoCapture && cooldownSeconds > 0 ? (
                <p className="rounded-full bg-slate-900/75 px-4 py-2 text-center text-sm font-semibold text-white" role="status">
                  Ready in {cooldownSeconds}s — next person can step into frame
                </p>
              ) : guidance ? (
                <p className="rounded-full bg-slate-900/75 px-4 py-2 text-center text-sm font-semibold text-white" role="status">
                  {guidance}
                </p>
              ) : autoCapture && (capturing || steadyFrames > 0) ? (
                <p className="rounded-full bg-emerald-500/90 px-4 py-2 text-sm font-bold text-white" role="status">
                  Hold still…
                </p>
              ) : autoCapture ? (
                <p className="rounded-full bg-slate-900/75 px-4 py-2 text-sm font-semibold text-white" role="status">
                  Stand in front of the camera, head to feet, to be photographed automatically
                </p>
              ) : ready ? (
                <p className="rounded-full bg-emerald-500/90 px-4 py-2 text-sm font-bold text-white" role="status">
                  Ready to take photo
                </p>
              ) : null}

              {autoCapture && manualOffered && (
                <p className="rounded-xl bg-amber-500/95 px-4 py-2 text-center text-xs font-semibold text-white max-w-xs" role="status">
                  Stand straight in front of the camera with your whole body in the frame,
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

      <div
        className={inline
          ? 'pointer-events-none absolute inset-x-0 bottom-6 flex flex-col items-center gap-3'
          : 'flex flex-col items-center gap-3 py-6'}
        style={inline ? undefined : { paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <button
          type="button"
          onClick={() => void shoot()}
          hidden={autoCapture && !manualOffered}
          disabled={Boolean(error) || starting || capturing || !ready || cooldownSeconds > 0}
          aria-label={ready ? 'Capture photo' : 'Position one person in the camera to capture a photo'}
          className={`w-[72px] h-[72px] rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform disabled:opacity-40 flex items-center justify-center${inline ? ' pointer-events-auto shadow-lg' : ''}`}
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
