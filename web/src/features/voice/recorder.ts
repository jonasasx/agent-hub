/**
 * Microphone recording for dictation (design.md D7 `recorder.ts`): `getUserMedia` (mono, echo cancellation, noise
 * suppression), `MediaRecorder` with the first supported type (webm/opus in Chromium and Electron, mp4 in iOS Safari,
 * ogg/opus as the last resort) at 64 kbit/s, the sound level from an `AnalyserNode`. Every way out — «Готово»,
 * «Отмена», a recorder error — stops the tracks, so the browser's microphone indicator goes off.
 * Requirements (voice-input): Запись голоса; Ошибки доступа к микрофону; Отмена записи.
 */
import { t } from '../../i18n';

export const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'] as const;
export const AUDIO_BITS_PER_SECOND = 64_000;

/** A reason the recording did not start, with the text for the hint under the composer (design.md D7). */
export class MicError extends Error {
  constructor(
    readonly reason: 'denied' | 'not_found' | 'busy' | 'unsupported' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

// Getters: the text is taken in the current language at the moment of the error, not when the module loads.
export const MIC_TEXT = {
  get denied(): string {
    return t('chat.voice.mic.denied');
  },
  /** The same denial inside the desktop app: it has no address bar, only Windows privacy settings can block it. */
  get deniedApp(): string {
    return t('chat.voice.mic.deniedApp');
  },
  get not_found(): string {
    return t('chat.voice.mic.notFound');
  },
  get busy(): string {
    return t('chat.voice.mic.busy');
  },
  get unsupported(): string {
    return t('chat.voice.mic.unsupported');
  },
  get failed(): string {
    return t('chat.voice.mic.failed');
  },
};

/**
 * The page runs in the Agent Hub desktop app (Electron, `desktop/`): its window has no preload, so the only sign is
 * the `Electron/<version>` token Electron keeps in the default user agent of the window.
 */
export function isDesktopApp(userAgent: string | undefined = typeof navigator !== 'undefined' ? navigator.userAgent : undefined): boolean {
  return /\bElectron\/\d/.test(userAgent ?? '');
}

/** `getUserMedia` / `MediaRecorder` failure → the hint (design.md D7); `userAgent` picks the browser or app text. */
export function micError(err: unknown, userAgent?: string): MicError {
  if (err instanceof MicError) return err;
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return new MicError('denied', isDesktopApp(userAgent) ? MIC_TEXT.deniedApp : MIC_TEXT.denied);
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return new MicError('not_found', MIC_TEXT.not_found);
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return new MicError('busy', MIC_TEXT.busy);
  return new MicError('failed', MIC_TEXT.failed);
}

/** The first type of `MIME_CANDIDATES` the recorder supports, or '' (the recorder picks its own). */
export function pickMime(isTypeSupported: (t: string) => boolean): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      // a browser that throws on unknown types
    }
  }
  return '';
}

export interface Recording {
  /** Type of the recorded bytes (`Content-Type` of the upload). */
  readonly mime: string;
  /** Current loudness 0…1 for the wave. */
  level(): number;
  /** Stops and returns the recording; the microphone is released. */
  stop(): Promise<Blob>;
  /** Stops and drops the recording; the microphone is released. */
  cancel(): void;
}

type RecorderCtor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?: (t: string) => boolean;
};

export interface RecorderDeps {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  MediaRecorder?: RecorderCtor;
  AudioContext?: new () => AudioContext;
}

function defaults(): RecorderDeps {
  const g = globalThis as unknown as { MediaRecorder?: RecorderCtor; AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return {
    mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
    MediaRecorder: g.MediaRecorder,
    AudioContext: g.AudioContext ?? g.webkitAudioContext,
  };
}

/**
 * Asks for the microphone (if not granted yet) and starts recording. Throws `MicError`. `onError`: the recorder failed
 * while recording (MediaRecorder `error`) — not called once `stop()`/`cancel()` was asked (`stop()` rejects instead).
 */
export async function startRecording(deps: RecorderDeps = defaults(), onError?: (err: unknown) => void): Promise<Recording> {
  const { mediaDevices, MediaRecorder: Rec } = deps;
  if (!mediaDevices?.getUserMedia || !Rec) throw new MicError('unsupported', MIC_TEXT.unsupported);
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (err) {
    throw micError(err);
  }
  const release = () => {
    for (const t of stream.getTracks()) t.stop();
  };

  let recorder: MediaRecorder;
  const picked = pickMime(t => Rec.isTypeSupported?.(t) ?? false);
  try {
    recorder = new Rec(stream, { ...(picked ? { mimeType: picked } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
  } catch (err) {
    release();
    throw micError(err);
  }

  // the level: RMS of the waveform, scaled so that speech fills most of the bar
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  try {
    if (deps.AudioContext) {
      ctx = new deps.AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      buf = new Uint8Array(analyser.fftSize);
      // made after `await getUserMedia`, i.e. outside the click: Safari leaves such a context suspended — a flat wave
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    }
  } catch {
    // no wave is not a reason to refuse the recording
    analyser = null;
  }
  const closeAudio = () => {
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    ctx = null;
    analyser = null;
  };

  const chunks: Blob[] = [];
  let dropped = false;
  let done: Promise<Blob> | null = null;
  let resolveDone: (b: Blob) => void = () => undefined;
  let rejectDone: (e: unknown) => void = () => undefined;
  const settled = new Promise<Blob>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  settled.catch(() => undefined);
  const mimeOf = () => recorder.mimeType || picked || 'audio/webm';
  recorder.ondataavailable = (e: BlobEvent) => {
    if (!dropped && e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    release();
    closeAudio();
    resolveDone(new Blob(chunks, { type: mimeOf() }));
  };
  recorder.onerror = (e: Event) => {
    release();
    closeAudio();
    const err = (e as unknown as { error?: unknown }).error ?? new Error('recorder error');
    rejectDone(err);
    if (!done) onError?.(err);
  };
  try {
    // chunks every second: a long recording does not sit in one buffer of the recorder
    recorder.start(1000);
  } catch (err) {
    release();
    closeAudio();
    throw micError(err);
  }

  const halt = () => {
    try {
      if (recorder.state !== 'inactive') recorder.stop();
      else {
        release();
        closeAudio();
        resolveDone(new Blob(chunks, { type: mimeOf() }));
      }
    } catch {
      release();
      closeAudio();
      resolveDone(new Blob(chunks, { type: mimeOf() }));
    }
  };

  return {
    get mime() {
      return mimeOf();
    },
    level() {
      if (!analyser || !buf) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    },
    stop() {
      if (!done) {
        done = settled;
        halt();
      }
      return done;
    },
    cancel() {
      dropped = true;
      chunks.length = 0;
      if (!done) {
        done = settled;
        halt();
      }
    },
  };
}
