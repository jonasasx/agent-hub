// Requirements (voice-input): Запись голоса; Ошибки доступа к микрофону; Отмена записи (the microphone is released).
import { describe, expect, it, vi } from 'vitest';
import { AUDIO_BITS_PER_SECOND, MIC_TEXT, MicError, isDesktopApp, micError, pickMime, startRecording, type RecorderDeps } from './recorder';

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream(tracks = [new FakeTrack()]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

class FakeRecorder {
  static supported = new Set(['audio/webm;codecs=opus']);
  static last: FakeRecorder | null = null;
  static isTypeSupported = (t: string) => FakeRecorder.supported.has(t);
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  timeslice?: number;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions = {},
  ) {
    this.mimeType = options.mimeType ?? 'audio/webm';
    FakeRecorder.last = this;
  }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['abc'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  state = 'running';
  closed = false;
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  createAnalyser() {
    return {
      fftSize: 0,
      getByteTimeDomainData(b: Uint8Array) {
        b.fill(160); // a constant offset from the 128 midline: RMS 0.25 → level 1 after scaling
      },
    };
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
}

function deps(over: Partial<RecorderDeps> = {}, tracks = [new FakeTrack()]) {
  const getUserMedia = vi.fn(async () => fakeStream(tracks));
  return {
    getUserMedia,
    tracks,
    deps: {
      mediaDevices: { getUserMedia },
      MediaRecorder: FakeRecorder as unknown as RecorderDeps['MediaRecorder'],
      AudioContext: FakeAudioContext as unknown as RecorderDeps['AudioContext'],
      ...over,
    },
  };
}

describe('pickMime', () => {
  it('webm/opus first (Chromium, Electron), mp4 for iOS Safari, ogg as the last resort, else the recorder default', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMime(t => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMime(t => t === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
    expect(pickMime(() => false)).toBe('');
    expect(
      pickMime(() => {
        throw new Error('x');
      }),
    ).toBe('');
  });
});

describe('micError: getUserMedia errors → hints (design D7)', () => {
  it.each([
    ['NotAllowedError', 'denied', MIC_TEXT.denied],
    ['SecurityError', 'denied', MIC_TEXT.denied],
    ['NotFoundError', 'not_found', 'Микрофон не найден'],
    ['NotReadableError', 'busy', 'Микрофон занят другим приложением'],
    ['TypeError', 'failed', MIC_TEXT.failed],
  ])('%s', (name, reason, text) => {
    const e = micError(new DOMException('x', name));
    expect(e.reason).toBe(reason);
    expect(e.message).toBe(text);
  });
  it('the denial text names the site settings and Windows privacy settings', () => {
    expect(MIC_TEXT.denied).toMatch(/^Нет доступа к микрофону/);
    expect(MIC_TEXT.denied).toMatch(/настройках сайта/);
    expect(MIC_TEXT.denied).toMatch(/Windows/);
  });
});

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AgentHub/0.1.2 Chrome/140.0.7339.41 Electron/38.0.0 Safari/537.36';

describe('denial text: browser vs the desktop app (no address bar there)', () => {
  it('isDesktopApp: only the Electron token of the app window counts', () => {
    expect(isDesktopApp(APP_UA)).toBe(true);
    expect(isDesktopApp(CHROME_UA)).toBe(false);
    expect(isDesktopApp('')).toBe(false);
    expect(isDesktopApp('NotElectron/1')).toBe(false);
  });
  it('in a browser the denial points at the site settings', () => {
    const e = micError(new DOMException('x', 'NotAllowedError'), CHROME_UA);
    expect(e.reason).toBe('denied');
    expect(e.message).toBe(MIC_TEXT.denied);
  });
  it('in the app the denial points at the Windows privacy settings only', () => {
    const e = micError(new DOMException('x', 'NotAllowedError'), APP_UA);
    expect(e.reason).toBe('denied');
    expect(e.message).toBe('Нет доступа к микрофону. Разрешите его в параметрах Windows: Конфиденциальность и защита → Микрофон (включите доступ для классических приложений)');
    expect(e.message).not.toMatch(/адрес/);
  });
  it('other errors read the same in the app', () => {
    expect(micError(new DOMException('x', 'NotFoundError'), APP_UA).message).toBe(MIC_TEXT.not_found);
  });
  it('without an explicit user agent the page’s own navigator.userAgent decides (startRecording path)', async () => {
    const spy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    try {
      const getUserMedia = vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      });
      await expect(startRecording({ mediaDevices: { getUserMedia }, MediaRecorder: FakeRecorder as unknown as RecorderDeps['MediaRecorder'] })).rejects.toMatchObject({
        reason: 'denied',
        message: MIC_TEXT.deniedApp,
      });
      spy.mockReturnValue(CHROME_UA);
      await expect(startRecording({ mediaDevices: { getUserMedia }, MediaRecorder: FakeRecorder as unknown as RecorderDeps['MediaRecorder'] })).rejects.toMatchObject({
        message: MIC_TEXT.denied,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('startRecording', () => {
  it('asks for a mono microphone with echo cancellation and noise suppression; records webm/opus at 64 kbit/s', async () => {
    const d = deps();
    const rec = await startRecording(d.deps);
    expect(d.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    expect(FakeRecorder.last!.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    expect(AUDIO_BITS_PER_SECOND).toBe(64000);
    expect(rec.mime).toBe('audio/webm;codecs=opus');
  });

  it('iOS Safari: mp4', async () => {
    FakeRecorder.supported = new Set(['audio/mp4']);
    try {
      const rec = await startRecording(deps().deps);
      expect(FakeRecorder.last!.options.mimeType).toBe('audio/mp4');
      expect(rec.mime).toBe('audio/mp4');
    } finally {
      FakeRecorder.supported = new Set(['audio/webm;codecs=opus']);
    }
  });

  it('the level comes from the analyser, 0…1', async () => {
    const rec = await startRecording(deps().deps);
    expect(rec.level()).toBeGreaterThan(0.5);
    expect(rec.level()).toBeLessThanOrEqual(1);
  });

  it('without an AudioContext the recording still starts, the level is 0', async () => {
    const rec = await startRecording(deps({ AudioContext: undefined }).deps);
    expect(rec.level()).toBe(0);
  });

  it('Safari: a context made after getUserMedia starts suspended — it is resumed so the wave moves', async () => {
    const resumed: string[] = [];
    class Suspended extends FakeAudioContext {
      static last: Suspended | null = null;
      constructor() {
        super();
        this.state = 'suspended';
        Suspended.last = this;
      }
      resume() {
        resumed.push(this.state);
        this.state = 'running';
        return Promise.resolve();
      }
    }
    await startRecording(deps({ AudioContext: Suspended as unknown as RecorderDeps['AudioContext'] }).deps);
    expect(resumed).toEqual(['suspended']);
    expect(Suspended.last!.state).toBe('running');
  });

  it('a running context is not resumed; a failing resume() does not break the recording', async () => {
    const resume = vi.fn(() => Promise.reject(new Error('not allowed')));
    class Running extends FakeAudioContext {
      resume = resume;
    }
    const rec = await startRecording(deps({ AudioContext: Running as unknown as RecorderDeps['AudioContext'] }).deps);
    expect(resume).not.toHaveBeenCalled();
    class Rejecting extends FakeAudioContext {
      override state = 'suspended';
      resume = resume;
    }
    const rec2 = await startRecording(deps({ AudioContext: Rejecting as unknown as RecorderDeps['AudioContext'] }).deps);
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(rec.level()).toBeGreaterThan(0);
    expect(rec2.level()).toBeGreaterThan(0);
  });

  it('a recorder error while recording: onError at once, the microphone released, stop() rejects', async () => {
    const d = deps();
    const onError = vi.fn();
    const rec = await startRecording(d.deps, onError);
    const r = FakeRecorder.last!;
    r.state = 'inactive';
    r.onerror?.({ error: new DOMException('gone', 'UnknownError') });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ name: 'UnknownError' });
    expect(d.tracks[0]!.stopped).toBe(true);
    await expect(rec.stop()).rejects.toMatchObject({ name: 'UnknownError' });
  });

  it('a recorder error after stop() was asked: no onError, stop() rejects', async () => {
    const onError = vi.fn();
    const rec = await startRecording(deps().deps, onError);
    const r = FakeRecorder.last!;
    r.stop = () => {
      r.state = 'inactive';
      r.onerror?.({ error: new DOMException('late', 'UnknownError') });
    };
    await expect(rec.stop()).rejects.toMatchObject({ name: 'UnknownError' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('«Готово»: stop() gives the recorded bytes and releases the microphone', async () => {
    const d = deps();
    const rec = await startRecording(d.deps);
    expect(d.tracks[0]!.stopped).toBe(false);
    const blob = await rec.stop();
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(d.tracks[0]!.stopped).toBe(true);
    // a second stop() is the same result
    expect(await rec.stop()).toBe(blob);
  });

  it('«Отмена»: cancel() releases the microphone and keeps nothing', async () => {
    const d = deps();
    const rec = await startRecording(d.deps);
    rec.cancel();
    expect(d.tracks[0]!.stopped).toBe(true);
    expect(FakeRecorder.last!.state).toBe('inactive');
  });

  it('the recorder failing to construct releases the microphone', async () => {
    const tracks = [new FakeTrack()];
    const Broken = class {
      static isTypeSupported = () => true;
      constructor() {
        throw new DOMException('no', 'NotSupportedError');
      }
    };
    await expect(startRecording(deps({ MediaRecorder: Broken as unknown as RecorderDeps['MediaRecorder'] }, tracks).deps)).rejects.toBeInstanceOf(MicError);
    expect(tracks[0]!.stopped).toBe(true);
  });

  it('a denied permission → MicError «Нет доступа к микрофону»; asking again asks the browser again', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const d = { mediaDevices: { getUserMedia }, MediaRecorder: FakeRecorder as unknown as RecorderDeps['MediaRecorder'] };
    await expect(startRecording(d)).rejects.toMatchObject({ reason: 'denied' });
    await expect(startRecording(d)).rejects.toMatchObject({ reason: 'denied' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('no mediaDevices (insecure page) or no MediaRecorder → unsupported', async () => {
    await expect(startRecording({ MediaRecorder: FakeRecorder as unknown as RecorderDeps['MediaRecorder'] })).rejects.toMatchObject({ reason: 'unsupported' });
    await expect(startRecording({ mediaDevices: { getUserMedia: vi.fn() } })).rejects.toMatchObject({ reason: 'unsupported' });
  });
});
