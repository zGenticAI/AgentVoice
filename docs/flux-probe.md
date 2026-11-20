# Measuring Deepgram Flux (the flux probe)

A test you run on your own computer, with your real keys. These pages call the assistant Alex, its default name.

When someone talks over Alex, it pauses first, and stops only for words ([In a meeting](in-a-meeting.md#joining-leaving-and-stopping)). How well that works depends on things Deepgram Flux doesn't document: how it spells "mm-hm" and "uh-huh", whether a cough or a laugh starts a turn, how long the turn of a backchannel takes to end, how soon after someone starts speaking it says so, how often it sends updates, whether a turn ended by `ForceEndTurn` still arrives when the stream is closed straight after, whether `ForceEndTurn` still ends a turn on a stream that has had no audio for a while, and how long it keeps open a stream that gets no audio. The service's constants (`PAUSE_MAX_MS`, `TAIL_MS` and `STT_HOLD_MS` in `src/pipeline/session.ts`) and its word lists (`BACKCHANNEL_SOUND`, `BACKCHANNEL_WORDS` and `BACKCHANNEL_PHRASES` in `src/brain/attention.ts`) were set from Deepgram's documentation and need checking against the real thing.

`npm run flux-probe` measures them. It streams short test clips to Flux exactly as the service does, and prints a report for you to paste back to your coding session, which tunes the constants and lists from it.

It changes nothing: no setting, no meeting, and no file unless you pass `--json`. It never prints or writes a key.

## What you need

- `DEEPGRAM_API_KEY` in `.env`. Required.
- `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env`, for the spoken clips. Without them the probe says so and runs only the noise clips, and the protocol checks with silence instead of speech.
- For `--mic`, and for WAV files that are not already 16 kHz mono 16-bit: ffmpeg. On macOS `brew install ffmpeg`, on Linux `sudo apt install ffmpeg` (or your distribution's package). Without it the probe says how to install it and skips those clips.
- A network that lets websockets through to `api.deepgram.com`. `npm run check` shows whether the Flux stream opens.

## What it costs

The probe prints its costs line before it spends anything. A full run is at most about 4.5 minutes of Deepgram streaming audio over 32 streams (each clip has half a second of silence before it and up to 7 seconds after it), and about 300 ElevenLabs characters in the service's voice. `--mic` adds 5 streams of about 10 seconds, and `--nonverbal` 3 streams and about 30 characters on ElevenLabs' tagged model. The idle check keeps one stream open for up to 90 seconds with 1.5 seconds of audio in it, and the hold check one for about 10 seconds with the same. A stream that has to be tried again (see [What it sends](#what-it-sends)) costs again; the report's `Used:` line says what the run really used.

It takes about 6 minutes: the clips stream in real time, one after another, and the idle check waits.

## Running it

```bash
npm run flux-probe                                   # every clip and check
npm run flux-probe -- --mic                          # also your own cough, laugh, "mm-hm", "yeah" and a question
npm run flux-probe -- --files ~/clips                # also every .wav in a folder
npm run flux-probe -- --nonverbal                    # also ElevenLabs' [coughs], [laughs] and [clears throat]
npm run flux-probe -- --json data/flux-probe.json    # also write every raw event and the analysis
npm run flux-probe -- --only bc,noise-cough,idle     # just these clips and checks
```

| Option | What it does |
| --- | --- |
| `--mic` | Asks you, in the terminal, to cough once, laugh briefly, say "mm-hm", say "yeah", and say "hold on, what about the budget?". For each, press Enter, wait for `Now:` (the microphone takes a moment to start, and a sound made before then is lost), then make the sound. Each is recorded for a fixed 3 seconds through ffmpeg from your system's default input (avfoundation's `:default` on macOS; PulseAudio's default, else ALSA's, on Linux), then streamed like any clip; the report says which input it was. A recording with no sound in it is skipped, saying so: usually the terminal may not use the microphone, or the default input is a virtual device. The first time, macOS asks whether your terminal may use the microphone. |
| `--files <dir>` | Every `.wav` in the folder, named by its file name. 16 kHz mono 16-bit is used as it is; anything else is converted with ffmpeg, or skipped with the reason. A name starting `backchannel-`, `interruption-` or `noise-` says what the clip is meant to be, so the report can say when Alex would get it wrong. |
| `--nonverbal` | Asks ElevenLabs' tagged model for a cough, a laugh and a throat being cleared. Best effort: if ElevenLabs refuses the model or the tags, the report says "not available" and the run goes on. |
| `--json <path>` | Also writes every message Flux sent, with its time, and the analysis, to that file, readable only by you (0600; a folder it has to make is 0700). |
| `--idle-max <seconds>` | How long the idle check waits for Flux to close a stream with no audio. 90 unless set, at most 600. |
| `--only <ids>` | Only these clips and checks, comma-separated: an id from the report (`bc-mm-hm`, `int-wait`, `noise-cough`, `force-close`), or the start of ids (`bc` for every backchannel, `int`, `noise`, `nv`, `mic`, `file`, `force`). `cadence` is the long sentence it comes from. One that matches nothing is an error. |

## What it sends

Each clip goes on a fresh stream of its own, one at a time, to the address and with the key header the service uses: the same model, `eot_threshold` 0.7, the keyterms from your names and `DEEPGRAM_KEYTERMS`, and `mip_opt_out=true`. The audio is 16 kHz mono 16-bit in 80 ms chunks, as the bot page sends it, each sent once its 80 ms have passed, so it never goes faster than real time. A clip is half a second of silence, the clip, then silence until Flux has ended the turn (or 7 seconds, beyond Flux's own 5-second timeout), then `CloseStream`.

- **Backchannels**, spoken in the service's voice: "Mm-hm.", "Mm-hmm.", "Mhm.", "Uh-huh.", "Yeah.", "Yeah, yeah.", "Okay.", "Right.", "Sure.", "I see.", "Oh, I see.", "Got it.", "Sorry, go ahead.", "Ha ha.", "Hmm.", "Uh.", "Um.". None of these should stop Alex.
- **Interruptions**: "Wait.", "No.", "Thanks.", "Hold on, what about the budget?", "Alex, never mind.", "Alex, please leave." (with your assistant's name) and a sentence of about 6 seconds. Each of these should stop it.
- **Noise**, made in code, the same on every run: 1.5 seconds of silence, 300 ms of white noise, a cough-like double burst, and a breath-like 800 ms of quiet filtered noise. None of these should start a turn.

Deepgram fails a handshake, or drops a stream, now and then. A stream that does not open (a 429 or 5xx answer, no answer within 5 seconds, a network error), or that Flux closes before the probe is done with a clip, is tried once more on a fresh stream about 2 seconds later, and the report notes it. One that fails again is reported as failed, or as incomplete, and the run goes on. The run stops early only when Deepgram refuses the stream in a way trying again cannot fix (400, 401, 402, 403 or 404, as for a wrong key or no credit left: the service gives up on the same ones), or when three clips or checks in a row will not open even on a second try.

Then the protocol checks, with the long sentence:
- **force-close**: 1.5 seconds after its `StartOfTurn`, `ForceEndTurn` and at once `CloseStream`, as the service does when a meeting ends. Does the turn still arrive as an `EndOfTurn` (trigger `manual`) before the stream closes, and how soon?
- **force-only**: 1.5 seconds after its `StartOfTurn`, `ForceEndTurn` alone, while the rest of the sentence still streams. How soon does the `EndOfTurn` come while audio flows? The service never does just this: it is there to set against the hold check.
- **hold**: one second of the sentence, then no audio at all for `STT_HOLD_MS` (3 seconds), then `ForceEndTurn` alone if a turn is open, as the service does when the bot page has gone. Does the `EndOfTurn` still come, how soon, and before Flux closes the stream? If Flux answers `ForceEndTurn` only while audio comes, this is where it shows.
- **idle**: one second of the sentence, then no audio at all, and no `ForceEndTurn`. When, and with what close code, does Flux close the stream? Or is it still open after `--idle-max`?
- **cadence**, from the long sentence's own clip: how many updates Flux sends during speech and how far apart, and whether it sends any during the silence before it.

## Reading the report

It starts with what was measured against: the app and Node versions, the Flux settings (model, `eot_threshold`, how many keyterms) and the service's constants, then what the run used. `t` is the time in milliseconds from where the clip's audio starts: a message during the half second of silence before it has a negative `t`.

For each clip:
- `StartOfTurn`: when it came, how long after the clip's sound starts, where Flux put the first word, and what it heard.
- The updates during the turn (each different transcript once), and the `EndOfTurn`: how long after the clip ended, its trigger (`model`, `timeout` or `manual`), its confidence and its transcript, and the time from `StartOfTurn` to `EndOfTurn`.
- **Alex would**: the service's own rules, played over the clip as if Alex were partway through a long answer. Do nothing (no `StartOfTurn`); pause, then play on (at the `EndOfTurn`, or once `PAUSE_MAX_MS` has run out); pause, then stop; or stop at once.
- How the stream closed. A clip whose stream Flux closed before the probe was done with it (before the clip and a second of silence after it had gone, or with a turn still open) is marked **Incomplete**: what Flux would have sent is not known, so it is left out of the mismatches and suggestions.

**Mismatches** lists every clip that would not get what it was meant to: a backchannel that would stop Alex (with Flux's exact spelling and the words that counted), an interruption that would only pause it, or not be heard, and noise that started a turn.

**Protocol** has the force, hold, idle and cadence checks.

**Suggestions** are only suggestions: the probe changes nothing.
- `PAUSE_MAX_MS`: the 90th percentile of `StartOfTurn` to `EndOfTurn` over the backchannels that played on, plus 300 ms, kept between 800 and 3000.
- `TAIL_MS`: the median time from the sound starting to `StartOfTurn` over the spoken clips, kept between 200 and 1000.
- `STT_HOLD_MS`: from the hold check, whether `ForceEndTurn` still ended the turn after that long with no audio, before Flux closed the stream. If it did not, the service's hold path would lose the turn.
- Spellings: for each backchannel that would stop Alex, which list in `src/brain/attention.ts` its spelling would go in.

**Skipped** says what didn't run, and why.

## What to send back

Paste the whole report, from `===== Flux probe report =====` to `Paste this whole report back to your coding session (Claude Code, Codex or OpenCode).`, into your coding session. It holds no key and no address: the probe's own test phrases, and what Flux made of them. With `--mic` or `--files` it also holds what Flux heard in your recordings, which is only your own test speech: don't record anyone else.

Keep the `--json` file to yourself unless your session asks for it.

## What is kept

- On your computer: nothing, unless `--json` names a file. The probe reads `.env` only for the keys, the voice and the names.
- Deepgram: the probe opts out of Deepgram keeping the audio for model improvement, as the service does.
- ElevenLabs: the spoken clips are made as Alex's speech is, so ElevenLabs keeps them in your account's history unless `ELEVENLABS_ZERO_RETENTION=true` (enterprise accounts only).
