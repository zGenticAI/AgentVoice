# Measuring who is speaking (the speaker probe)

A test mode, for test meetings whose participants have agreed to it. These pages call the assistant Alex, its default name.

Today everyone but Alex is "Speaker" in the transcript and the minutes. Naming speakers would come from Recall's participant events: who joined, who left, and who started and stopped speaking. How well those events line up with the turns Alex hears isn't documented anywhere, and differs by platform. The speaker probe measures it, in meetings set up for the test, and keeps only numbers. Nothing in the transcript or the minutes changes: speakers are still "Speaker".

## Two keys

1. `SPEAKER_PROBE=1` (or `true`) in `.env`, then restart the service. It says so at every start, `npm run check` shows `Speaker probe: on`, and the control `/health` has `"speaker_probe": true`. Unset or empty, it is off; any other value is off too, with a warning.
2. Each test meeting asks for it: `npm run join -- "<link>" --speaker-probe`. A meeting joined without the flag, and every meeting your Claude Code session joins with `join_meeting`, has no probe. With `SPEAKER_PROBE` off, the flag is refused: "SPEAKER_PROBE is not set in .env". A service older than this command has no probe, and `npm run join` refuses rather than send Alex in without it.

Remove `SPEAKER_PROBE` from `.env` when the tests are done.

## What changes in a meeting with the probe

- The bot also subscribes to Recall's participant events: join, leave, update (a rename, say), speech_on and speech_off. Recall sends them live, with each participant's display name, platform ids (such as Zoom's `conf_user_id`, or Teams' `user_id` and `tenant_id`) and whether they are speaking, through your tunnel to the service, at `/recall/`. Recall keeps none of them after the meeting (the bot still uses zero data retention).
- The service turns each event into categories at once: whether the name looks like a phone number or a placeholder ("Guest", "Call-in User_1"), whether it is the bot's own name, whether it is a test label ("Probe Alpha"), and a hash of it under a secret that is new for each meeting and never written, to tell a rename from a re-join. It keeps no name, id, email or word.
- It notes, for each turn Alex hears, when it started and ended and when the audio of its first and last word came in, how many words it had and which test code word it starts with: never its words. And when Alex's own voice plays.
- When the meeting ends, it writes one file of counts and timings: `data/speaker-probe/<the transcript's file name>.json`, readable only by you (0600, in a 0700 folder). Timings are sorted and rounded to 10 ms, so the file holds no timeline. Its only text is its own keys, a few fixed words (the platform, how the meeting ended) and the date.

What it never does:
- No name, id or word in a file or in the log. The log has the bot's id and the connection's states only.
- Nothing new goes to Anthropic, Deepgram, ElevenLabs, your Claude Code session or the meeting chat. `meeting_ended` is the same.
- Nothing about what Alex says or does changes: the consent line, the chat notice and the goodbye are the same, and are heard in full.

## Deleting the measurements

- "Alex, please leave", or removing Alex, deletes what was measured: no file is written for that meeting, and Recall's connection is closed at once.
- A file already written goes with the meeting's transcript: a later "please leave" in the same meeting deletes it, and so does the retention sweep after `TRANSCRIPT_RETENTION_DAYS`.
- To clear them all: `rm -r data/speaker-probe`.

## Test meetings only

The consent line and the chat notice don't mention the probe, so it is only for meetings set up to test it:
- every participant has agreed beforehand, in the invitation, to a test of who-is-speaking detection;
- never with clients, candidates, or anyone who hasn't agreed;
- turn it off when the tests are done.

While it is on, the participants' display names, platform ids and speaking reach your tunnel provider in transit and the service's memory, though nothing named is kept.

## A test meeting

Before any meeting:
- Set `SPEAKER_PROBE=1` and restart the service: `npm run check` shows "Speaker probe: on".
- Write a test brief (`data/brief.md`): "If asked about this meeting, say: this is a test of how speaking is detected; please speak one at a time, and start each turn with your code word."
- Invite the testers with a note that this is a test of who-is-speaking detection, and that names are not kept. Everyone agrees in writing.
- Have a phone ready for dial-in, and the dial-in numbers enabled on each platform.

Roles and display names, set before joining:
- Alpha: the host, on their own account, "Probe Alpha".
- Bravo: "Probe Bravo".
- Charlie: "Probe Charlie", who joins late.
- Echo: dials in by phone. Never rename the phone caller: its default name is part of what is measured.
- Foxtrot: two people sharing one laptop, as one participant called "Probe Foxtrot", standing in for a room system.
- Optional: a real room system (a Zoom Room, Meet hardware or a Teams Room). Its turns start with "Golf" and are not scored; they show how several voices on one device behave.

Every turn starts with the speaker's code word as its first word. Never say "Alex" except where the script says to, and never say "leave".
- Short turns, about 1 s: "<Code> here." / "<Code>, okay." / "<Code>, yes."
- Long turns, 5 to 8 s: "<Code>. I am reading a longer sentence now, so that this turn lasts several seconds before I stop talking."

One meeting of 15 to 18 minutes on each platform (Zoom, Google Meet, and Microsoft Teams with a business tenant), and a second one on another day or network if you can: whether a timing stays put from one meeting to the next needs two.
0. Before the bot: Alpha and Bravo are in the meeting. Bravo stays muted and silent. Note "2 present before the bot".
1. Send the bot: `npm run join -- "<link>" --speaker-probe`, and admit it. Everyone stays silent through the whole consent line, about 17 s: this shows whether the bot's own participant fires speech_on while it talks.
2. Charlie joins late. Echo dials in. Wait 10 s.
3. Single turns, one at a time, with at least 2 s of silence between them: Alpha, Bravo, Charlie, Echo, Foxtrot's first person, Foxtrot's second. Each says 3 short and 3 long turns: 36 turns.
4. Quick handovers, 10 pairs: the second speaker starts within half a second of the first stopping (Alpha then Bravo, Bravo then Charlie, Charlie then Echo, Echo then Foxtrot, and so on), each a long turn. This tests a late speech_off, as on Meet and Teams.
5. The same speaker after a pause: Alpha, Bravo and Charlie each say a long turn, pause 3 s, then another long turn starting with the code word again. Twice each.
6. Overlap: three times, Alpha and Bravo start long turns at the same moment (count down). The probe should give these to nobody.
7. Alex talks: Alpha says "Alex, what is this meeting about?" and everyone stays silent until the answer has finished. Twice. Then once more, with Bravo talking over the answer with a long Bravo turn.
8. A rename, where the platform allows it (Zoom; Teams and Meet only if offered): Charlie renames to "Probe Delta", then says 2 long "Delta" turns.
9. A re-join: Bravo leaves, rejoins within 30 s (on Meet this may make a second participant), then says 2 long "Bravo" turns.
10. Noise: Alpha coughs or claps 3 times, 3 s apart, with no words.
11. Silence: nobody speaks for 70 s. This tests the connection's keepalive through the tunnel.
12. The host ends the meeting for everyone.

On Teams, in the same meeting: one tester joins as an anonymous guest from a browser, not signed in, and one signed-in tester has "Automatically identify me in meeting captions and transcripts" turned off. Both take part in step 3 with their own code words (Delta for the guest if Charlie hasn't renamed in this meeting).

Deletion checks, in short meetings of 2 to 3 minutes:
- Zoom: steps 1 and 3 (two turns), then "Alex, please leave". Afterwards the meeting has no file, and `npm run speaker-report` counts the same meetings as before.
- Meet: the same, but the host removes Alex from the participant list.
- Any platform, with `SPEAKER_PROBE` unset: one short meeting. The log has no `[events]` lines, and no file is written.

After each meeting:
- `npm run speaker-report`;
- `ls -l data/speaker-probe`: the files are `-rw-------`;
- `grep -i -e "probe alpha" -e "probe bravo" -e "<the phone number>" data/agent-voice.log`: nothing;
- the report's "Events connection" line shows at least 1 connection. With none, Recall never connected: check the tunnel, and that the bot was created with the probe (`npm run join` says so).

How much is enough: at least 40 scored normal turns per platform; one full meeting gives about 60. Both deletion checks should pass before the numbers are used.

Before trusting any numbers, check in the first test meeting what can't be checked without one: that Recall took the bot request (if not, `npm run join` shows Recall's refusal), that its events arrive (the report's events connection has at least 1 connection, and events are counted), and that none are dropped as malformed (if they are, Recall's messages differ from its documentation, and the reading of them has to be fixed first).

## Reading the report

`npm run speaker-report` pools every file by platform and prints what they measured; `npm run speaker-report -- --json` prints the same numbers as JSON. It only reads: the probe's own files (regular files with its kind and version, no links), and it says how many others it skipped. It makes no decisions: the rules below are a guide to reading it.

What it shows for each platform:
- **Turns:** how many, how many could be timed (by the turn's audio window, or by word times when Flux sends them), and their classes: single (one human speaking around it), crowded (two, or another turn close by), no event (nobody, by Recall's account), while agent (Alex's voice was playing), already open (single, but the speaker's speaking began in an earlier turn) and short (under a second).
- **Scored turns:** timed turns that start with a code word, matched against who had that test label then (a rename included; "Echo" is the phone callers when nobody is labelled so). "With a code word nobody had" means the label and the code word didn't meet: check the display names.
- **Timings,** in milliseconds, with how many, the 10th, 50th and 90th percentiles, and the spread between the 25th and the 75th (IQR):
  - speech_on's arrival, from the first word's: how long after the first word's audio came in Recall's speech_on did. Negative means before.
  - speech_on by Recall's clock, from the first word's arrival: the same, by Recall's own time for the event.
  - from Flux's StartOfTurn; speech_off from the last word's; speech_on that came after the turn ended; gaps in one speaker's speaking within a turn (Zoom's bursts); each event's delay from Recall's time for it to its arrival; and how far Flux's audio window ran behind the audio sent to it.
  - Each meeting's median of the first, and how Recall's clock moves against its own relative time.
- **Participants:** how many, how they were first seen, joins in the first 5 s, re-joins under the same or a new id, renames, host changes, platforms, the shapes of names, whether a stable id or an email came, and the phone callers: how many, their name shapes, and whether they spoke.
- **The bot:** whether its own participant was seen (by its name, exactly or with something after it), its speech_on (and how many came during Alex's voice), and other participants who spoke mostly while Alex did.
- **Events connection:** connections, replacements, silent connections cut, how they closed, what was dropped and why (too big, too many, malformed, another bot's, an event not subscribed to, over the caps), meetings with no events, how soon the first event came after the page connected, and the longest quiet.
- **Settings:** with at least 40 scored normal turns, the settings that were right at least 98% of the time, by coverage (the share of scored turns they named correctly), with their short-turn precision and their coverage 10 s later. A setting is `clock|before ms|after ms|least share|ratio`: the clock (`rx`, when events arrived here, or `abs_adj`, Recall's own time corrected by the turns before), how far before the first word and after the last word a participant's speaking still counts, the least share of that window the winner must cover, and how many times the runner-up's the winner's must be. Below 40 it says "not enough data".

A guide to what the numbers say for naming speakers, by platform:
- **The clock.** Compare the IQR of "speech_on's arrival, from the first word's" with that of "speech_on by Recall's clock". Use the tighter one. If one platform's median moves more than 150 ms from one meeting to the next, a fixed shift won't do: correct it as `abs_adj` does, from the turns before.
- **The settings.** On the end-of-turn view, normal turns, take the setting with the most coverage among those right at least 98% of the time; on a tie, the smaller tolerances. If none reaches 98% on a platform, don't name speakers there. If short turns are right less than 95% of the time with it, leave turns under a second unnamed.
- **Late events.** If speech_on came after the turn ended in more than 2% of single turns, or the coverage 10 s later is more than 5 points above the end-of-turn coverage, names should be settled at minutes time, not as each turn ends.
- **The bot.** If its participant was always seen with its exact name and nobody else spoke mostly while Alex did, its name is enough to leave it out. Otherwise match by the start of its name too, and learn its id from speech_on during Alex's voice.
- **The roster.** If the joins in the first 5 s cover those present before the bot (2 in the script) and nobody was present without a join, join events give the starting roster.
- **Phone callers.** If they show as `dial_in`, label them "Phone caller N"; if only by a phone-like name, go by the name. If they never spoke on a platform, they can't be named there.
- **Re-joins and renames.** Re-joins under a new id mean a returning name should get its old label back; renames mean labels follow update events.
- **Zoom's bursts.** The gap within one speaker's turn, at its 90th percentile and rounded up to 100 ms, is how close two stretches must be to count as one (700 ms is the guess before measuring).
- **The connection.** If connections were cut for silence, or replaced while the tunnel was idle, the keepalive needs to be more frequent than every 30 s.
- **Noise.** speech_on with no words near it shows that names must hang on Flux's words, never on speech_on alone.
