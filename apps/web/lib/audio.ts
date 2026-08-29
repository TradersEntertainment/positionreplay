/**
 * The player's piano, built from oscillators rather than samples.
 *
 * What the replay should sound like is decided in `packages/renderer/src/score.ts`,
 * which is pure and knows nothing about browsers. This file is the other half: it turns
 * that list of notes into sound and nothing else. The split is the same one SPEC §7
 * makes for the picture — the decision is portable, the output device is not.
 *
 * No audio files. A piano note is a struck string: a fast attack, an exponential decay,
 * and a few harmonics above the fundamental that fade faster than it does. Three
 * detuned oscillators through a lowpass envelope is a recognisable electric piano, it
 * is about forty lines, and it adds nothing to the bundle. A sampled Steinway would
 * sound better and would be several megabytes of asset for a chart.
 *
 * Everything is scheduled against `AudioContext.currentTime`, never `setTimeout`. The
 * audio clock is the only one in the browser that does not drift, and a note started
 * from a timer arrives late enough to hear.
 */

import {
  ATTACK_SECONDS,
  DECAY_FLOOR,
  DETUNE_CENTS_PER_RATIO,
  LIMITER,
  MASTER_GAIN,
  midiToHz,
  partialsFor,
  voicePeak,
  type Note,
} from '@trade-replay/renderer';

/**
 * Notes allowed to sound in a single tick.
 *
 * At 4x speed one animation frame can cross several beats. Playing them all turns the
 * melody into a chord stab on every tick; dropping to the most recent few keeps it a
 * melody that is simply moving faster, which is what speeding up should sound like.
 */
const MAX_NOTES_PER_TICK = 3;

/**
 * The voice — partials, level, envelope, limiter — comes from the renderer's synth.ts,
 * which also renders it offline for the server's MP4. Two definitions of "what the piano
 * sounds like" would mean the downloaded file was a different instrument from the one
 * that was previewed.
 */

export interface ReplayAudio {
  /**
   * Sound whatever falls between the last index and this one.
   *
   * Called from the render loop, so it must stay cheap and must never allocate a node
   * when there is nothing to play.
   */
  advanceTo(index: number): void;
  /** Move the cursor without sounding anything — a scrub is not a performance. */
  seek(index: number): void;
  setMuted(muted: boolean): void;
  /** Browsers require a user gesture before audio starts; call this from the button. */
  resume(): Promise<void>;
  /**
   * What the audio context is actually doing.
   *
   * Exposed because "suspended" and "playing quietly" look identical from outside, and
   * that ambiguity is how a silent player shipped: the page said "Sound on" while the
   * browser had never started the context. The UI reads this to say what is true, and
   * the browser test reads it to assert the thing it could not before.
   *
   * `AudioContextState` rather than a hand-written union: Safari adds `'interrupted'`
   * when a call or another app takes the audio session, and a narrower type here would
   * mean pretending that state does not exist.
   */
  state(): AudioContextState;
  /**
   * Notes struck since this graph was created.
   *
   * The only direct evidence that sound was produced. Inferring it from the exported
   * file does not work — the export drives its own graph and can carry audio while the
   * live player is mute.
   */
  strikes(): number;
  /**
   * An audio track carrying this same output, for MediaRecorder.
   *
   * Null when the browser has no `createMediaStreamDestination`. The exported clip then
   * has no sound rather than failing to record at all.
   */
  captureTrack(): MediaStreamTrack | null;
  close(): void;
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export interface ReplayAudioOptions {
  /**
   * Record the notes without playing them out of the speakers.
   *
   * The export runs the replay in real time, so a graph connected to `destination`
   * would play the whole soundtrack aloud while someone waits for their download. The
   * capture destination pulls the graph on its own, so the recorder still gets every
   * note.
   */
  silent?: boolean;
}

export function createReplayAudio(
  notes: readonly Note[],
  options: ReplayAudioOptions = {},
): ReplayAudio | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;

  const ctx = new Ctor();

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;

  /**
   * A limiter, so the notes can be loud without the overlaps clipping.
   *
   * Up to three notes ring at once and their tails sum. Without this, a level loud
   * enough for a single note distorts on a run of them; with it, the loud passages are
   * held down and the quiet ones stay audible. It sits after the master gain so both the
   * speakers and the recorder get the same signal.
   */
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.thresholdDb;
  limiter.knee.value = LIMITER.kneeDb;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attackSeconds;
  limiter.release.value = LIMITER.releaseSeconds;
  master.connect(limiter);

  if (!options.silent) limiter.connect(ctx.destination);

  // A second destination so the recorder hears exactly what the speakers do, rather
  // than a separately rendered copy that could drift out of step with it.
  const capture =
    typeof ctx.createMediaStreamDestination === 'function' ? ctx.createMediaStreamDestination() : null;
  if (capture) limiter.connect(capture);

  let muted = false;
  let cursor = 0;
  let lastIndex = -1;
  let struck = 0;

  /** First note at or after `frame`. The list is sorted, so this is a plain search. */
  function cursorFor(frame: number): number {
    let low = 0;
    let high = notes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (notes[mid]!.frame < frame) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function strike(note: Note, at: number): void {
    const hz = midiToHz(note.midi);

    const voice = ctx.createGain();
    voice.gain.value = 0;
    voice.connect(master);

    const oscillators: OscillatorNode[] = [];
    for (const { ratio, level, wave } of partialsFor(note.voice)) {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.value = hz * ratio;
      osc.detune.value = ratio === 1 ? 0 : DETUNE_CENTS_PER_RATIO * ratio;

      const partial = ctx.createGain();
      partial.gain.value = level;
      osc.connect(partial);
      partial.connect(voice);
      oscillators.push(osc);
    }

    const peak = voicePeak(note);
    const end = at + note.duration;

    voice.gain.setValueAtTime(0, at);
    voice.gain.linearRampToValueAtTime(peak, at + ATTACK_SECONDS);
    // exponentialRamp cannot reach zero, so it decays to a floor and is then cut. A
    // linear ramp here sounds like a fade-out rather than a decay.
    voice.gain.exponentialRampToValueAtTime(Math.max(peak * DECAY_FLOOR, 0.0001), end);
    voice.gain.setValueAtTime(0, end);

    for (const osc of oscillators) {
      osc.start(at);
      osc.stop(end + 0.02);
    }

    // Nodes are one-shot; without this the graph grows for the length of the replay.
    const lastOsc = oscillators[oscillators.length - 1];
    if (lastOsc) {
      lastOsc.onended = (): void => {
        voice.disconnect();
      };
    }
  }

  return {
    advanceTo(index: number): void {
      if (index === lastIndex) return;
      // A jump backwards is a seek, not a performance; the notes between are not played.
      if (index < lastIndex) {
        cursor = cursorFor(index + 1);
        lastIndex = index;
        return;
      }
      lastIndex = index;

      // Muted means the notes went by; the cursor moves so unmuting starts from here
      // rather than replaying everything that was missed.
      if (muted) {
        cursor = cursorFor(index + 1);
        return;
      }

      // Suspended is different, and getting it wrong is why the player was silent. The
      // browser has not started the context yet — `resume()` is async and a few frames
      // pass before it takes effect. Advancing the cursor here would discard the notes
      // in that gap, which are the opening of the piece. Hold position instead: they
      // sound a beat late, which nobody notices, rather than never.
      if (ctx.state !== 'running') return;

      const due: Note[] = [];
      while (cursor < notes.length && notes[cursor]!.frame <= index) {
        due.push(notes[cursor]!);
        cursor++;
      }
      if (due.length === 0) return;

      const now = ctx.currentTime;
      for (const note of due.slice(-MAX_NOTES_PER_TICK)) {
        strike(note, now);
        struck++;
      }
    },

    seek(index: number): void {
      cursor = cursorFor(index + 1);
      lastIndex = index;
    },

    setMuted(next: boolean): void {
      muted = next;
      // Ramped rather than set: a gain that jumps produces an audible click.
      master.gain.linearRampToValueAtTime(next ? 0 : MASTER_GAIN, ctx.currentTime + 0.02);
    },

    async resume(): Promise<void> {
      if (ctx.state === 'suspended') await ctx.resume();
    },

    state(): AudioContextState {
      return ctx.state;
    },

    strikes(): number {
      return struck;
    },

    captureTrack(): MediaStreamTrack | null {
      return capture?.stream.getAudioTracks()[0] ?? null;
    },

    close(): void {
      void ctx.close().catch(() => undefined);
    },
  };
}
