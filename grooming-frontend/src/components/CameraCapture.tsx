import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, SwitchCamera, X } from 'lucide-react';

type Facing = 'user' | 'environment';

interface CameraCaptureProps {
  facing: Facing;
  onFlip: () => void;
  onCapture: (file: File) => void;
  onClose: () => void;
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

/**
 * A live camera viewfinder with a shutter, replacing the file picker.
 *
 * Attendance photos are evidence of appearance on a given day, so the photo
 * has to be taken now rather than chosen from a gallery. A file input cannot
 * enforce that — `capture` is only a hint, and on desktop it opens a file
 * browser — so the frame is grabbed from the camera stream directly.
 */
export default function CameraCapture({ facing, onFlip, onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [capturing, setCapturing] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;
    setStarting(true);
    setError('');

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot open the camera. Use a recent Chrome, Safari, or Edge.');
        setStarting(false);
        return;
      }
      try {
        // `ideal` rather than `exact`: a tablet with only one camera should
        // still open it instead of failing the whole capture.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
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
        if (!disposed) setStarting(false);
      }
    };

    void start();
    return () => {
      disposed = true;
      stop();
    };
  }, [facing, stop]);

  // Releasing the camera when the screen is hidden matters on Android, where
  // a held stream keeps the camera indicator on and blocks other apps.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [stop]);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setCapturing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      // The preview is mirrored for the front camera because an unmirrored
      // self-view is disorienting, but the saved photo must not be: a mirrored
      // image reverses text on a lanyard or badge.
      context.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92),
      );
      if (!blob) throw new Error('encode failed');
      onCapture(new File([blob], `check-in-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    } catch {
      setError('The photo could not be captured. Try again.');
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col" role="dialog" aria-modal="true" aria-label="Take photo">
      <div
        className="flex items-center justify-between px-4 py-3 text-white"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close camera"
          className="w-11 h-11 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"
        >
          <X size={22} aria-hidden="true" />
        </button>
        <p className="text-sm font-semibold">Take photo</p>
        <button
          type="button"
          onClick={onFlip}
          aria-label={facing === 'user' ? 'Switch to back camera' : 'Switch to front camera'}
          className="w-11 h-11 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"
        >
          <SwitchCamera size={22} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 relative overflow-hidden">
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
            {starting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black" role="status">
                <RefreshCw size={28} className="animate-spin text-white/60" aria-hidden="true" />
              </div>
            )}
          </>
        )}
      </div>

      <div
        className="flex items-center justify-center py-6"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        <button
          type="button"
          onClick={shoot}
          disabled={Boolean(error) || starting || capturing}
          aria-label="Capture photo"
          className="w-[72px] h-[72px] rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform disabled:opacity-40 flex items-center justify-center"
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
