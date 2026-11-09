// ElevenLabs streaming text-to-speech, returned as 16 kHz mono PCM16 to match the page's playback.
import { config, required } from '../config.ts'

export const TTS_MODEL = 'eleven_flash_v2_5'

/**
 * The streaming address. By default ElevenLabs keeps each request, Alex's spoken audio included, in
 * the account's history. enable_logging=false is its zero retention mode, which "may only be used by
 * enterprise customers", so it is sent only when ELEVENLABS_ZERO_RETENTION=true says the account has it.
 * https://elevenlabs.io/docs/api-reference/text-to-speech/stream
 */
export function ttsUrl(voiceId: string, zeroRetention = config.elevenLabsZeroRetention): string {
  const params = new URLSearchParams({ output_format: 'pcm_16000' })
  if (zeroRetention) params.set('enable_logging', 'false')
  return `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?${params}`
}

/**
 * A failed request as the log gets it: the status, and ElevenLabs' short error code if its reply has one
 * ({"detail":{"status":"quota_exceeded",...}}), never the rest of the reply, which can quote the text it was asked to
 * speak: the assistant's answer, which comes from the meeting.
 */
export function ttsError(status: number, body: string): string {
  let code = ''
  try {
    const detail = JSON.parse(body)?.detail
    code = String(detail?.status ?? detail?.code ?? '')
  } catch {
    // Not JSON: nothing of it is kept.
  }
  return `ElevenLabs ${status}${/^[\w.-]{1,60}$/.test(code) ? ` (${code})` : ''}`
}

/** Re-chunks a byte stream so every chunk holds whole 16-bit samples. */
export async function* wholeSamples(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let carry: Buffer | null = null
  for await (const piece of source) {
    let buf = Buffer.from(piece)
    if (carry) {
      buf = Buffer.concat([carry, buf])
      carry = null
    }
    if (buf.length % 2 === 1) {
      carry = buf.subarray(buf.length - 1)
      buf = buf.subarray(0, buf.length - 1)
    }
    if (buf.length) yield buf
  }
}

export async function* synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const res = await fetch(ttsUrl(required('ELEVENLABS_VOICE_ID')), {
    method: 'POST',
    signal,
    headers: {
      'xi-api-key': required('ELEVENLABS_API_KEY'),
      'content-type': 'application/json',
      accept: 'audio/pcm',
    },
    body: JSON.stringify({ text, model_id: TTS_MODEL }),
  })
  if (!res.ok || !res.body) throw new Error(ttsError(res.status, await res.text().catch(() => '')))
  yield* wholeSamples(res.body as unknown as AsyncIterable<Uint8Array>)
}
