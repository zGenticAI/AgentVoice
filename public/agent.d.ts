// The types of public/agent.js, which the bot page loads as it is. For the tests, which import it under tsc: the
// service doesn't serve this file.

/** The assistant's voice on the bot page (see createPlayer in agent.js). */
export interface Player {
  /** A piece of the voice arrived: PCM16, 16 kHz, mono. */
  play(pcm: ArrayBuffer): void
  /** Stops where it is, and holds the rest and whatever arrives, until resume or clear. Again: nothing. */
  pause(): void
  /** Plays what it held, back to back, 50 ms from now. Not paused: nothing. */
  resume(): void
  /** Drops everything not yet played, and what it held: a clear ends a pause. */
  clear(): void
  readonly paused: boolean
}

/** Streams the meeting's audio to the service and plays the assistant's voice. Resolves with a function that stops both. */
export function startAgent(options: {
  onState?: (state: string) => void
  onOutput?: (output: AnalyserNode) => void
}): Promise<() => void>

/** Turns the capture worklet's blocks of samples into frames of 1280 PCM16 samples, each given to send once full. */
export function createFramer(send: (frame: Int16Array) => void): (samples: Float32Array) => void

/** Plays the voice on ctx through output. onChange(true) as a piece is scheduled, onChange(false) once none plays. */
export function createPlayer(ctx: BaseAudioContext, output: AudioNode, onChange: (speaking: boolean) => void): Player
