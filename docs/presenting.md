# Presenting slides

How Alex presents a slide deck you prepared: exporting it as a PDF, `npm run slides -- prepare`, writing the script Alex reads from, `npm run slides -- check`, and then, in a meeting, sharing the slides as its screen and saying your script over them, word for word. These pages call the assistant Alex, its default name, and you, its owner, Sam.

Preparing and checking a deck happen on your computer, need no key and no network, and touch no meeting. [Presenting in a meeting](#presenting-in-a-meeting) covers the rest.

## Before your first presentation

**Presenting is off on every platform until you turn it on.** Alex shares its slides as a second page beside its camera page, which carries its voice and its hearing. Whether a share started mid-call leaves that camera page running is known only from a real meeting, so:
1. Run [the screen-share test](share-test.md) in a meeting you host on the platform: `npm run join -- "<link>" --share-test`.
2. Once its verdict says slides look safe there, add the platform to `SLIDES_PLATFORMS` in `.env` (comma-separated: `zoom`, `google_meet`, `microsoft_teams`), and restart the service: `SLIDES_PLATFORMS=zoom`.

Until then, a join with slides on that platform is refused before any bot is created, with a message that names the platform, the test and the setting:

```
Presenting slides is off on Zoom. Run the screen-share test in a Zoom meeting you host first (docs/share-test.md). Once it passes, add zoom to SLIDES_PLATFORMS in .env (it lists none yet) and restart the service.
```

A meeting bot also shares its screen only where the host allows it, and the setting differs on each platform: see [The platform settings](#the-platform-settings).

## The steps

Keep your PDFs in `decks/` in this folder, which is gitignored, or outside this folder: the repository is public, and the script is written beside the PDF. (`decks/` is yours; `data/decks/` is where prepare keeps the prepared decks.)

1. Export your deck as a PDF (below). The PDF keeps your fonts and layout exactly.
2. `npm run slides -- prepare decks/q4-roadmap.pdf`. It makes one image per slide, and writes `decks/q4-roadmap.script.md` next to your PDF, with a section for each slide.
3. Write what Alex should say in each section, or ask your Claude Code session to draft it, then read it yourself.
4. `npm run slides -- check decks/q4-roadmap.script.md`. It checks the script, estimates the time, and refreshes the contact sheet: every slide exactly as the meeting will see it.

## Exporting a PDF

Only a PDF is prepared. Export it from the app you made the deck in:

| App | How |
| --- | --- |
| PowerPoint | File > Export > PDF (or Save As > PDF). In the options, include hidden slides if it offers to. |
| Keynote | File > Export To > PDF. Tick "Include skipped slides". Leave "Include presenter notes" off: it puts your notes on the pages. "Print each stage of builds" makes each build step a page of its own. |
| Google Slides | File > Download > PDF document. Unskip any skipped slide you want in the PDF first. |
| Canva | Share > Download, with PDF Standard as the file type. |
| LibreOffice Impress | File > Export as PDF. Tick "Export hidden pages". |
| Marp | `marp --pdf --pdf-notes deck.md`. Your notes come with it, as hints in the script. |
| Slidev, reveal.js | `slidev export`, or decktape. |

**Slide numbers are PDF page numbers.** "Slide 5" always means page 5 of the PDF. Include your hidden slides when you export, so that the page numbers match the numbers on your slides; then mark the hidden ones `exclude: yes` (never shown) or `on-request: yes` (a backup slide) in the script. Page labels, if your PDF has them, are shown as hints only: they can repeat (a Beamer deck numbers each build step the same), so they are never a slide's number.

What prepare does with other files is decided by what is in them, never by their name, so a `.pdf` that is really a PowerPoint file gets the PowerPoint answer:

| You give it | It says |
| --- | --- |
| PowerPoint (`.pptx`, `.ppsx`) | Export it as PDF: File > Export > PDF (or Save As > PDF), with hidden slides included. |
| PowerPoint with macros (`.pptm`, `.ppsm`) | This file contains macros. Save it as a PDF and use that. |
| An old binary file (`.ppt`) | Save it as .pptx or export a PDF. |
| OpenDocument (`.odp`) | LibreOffice Impress: File > Export as PDF. |
| Keynote (`.key`) | Keynote: File > Export To > PDF (tick 'Include skipped slides'). |
| A Google Slides link | Google Slides: File > Download > PDF document. |
| Markdown or HTML (Marp, Slidev, reveal.js) | Export it to PDF (`marp --pdf --pdf-notes`, `slidev export`, decktape). |
| An image, or a folder of them | Put the images into one PDF. |
| A PDF that needs a password to open | This PDF is password-protected: export it again without a password. |

A PDF with only an owner password (one that stops printing or copying, but opens without a password) is fine.

### What is lost

| In your deck | What the meeting gets |
| --- | --- |
| Animations and builds | The state the PDF has: usually the final one. |
| Transitions | None: slides change at once. |
| Video and audio | The video's first frame, with no sound. |
| Fonts | Exactly as the PDF has them. |
| Links | Shown, but nobody can click a shared screen. |
| Speaker notes | Not used: Alex says only your script. |
| Comments, ink, sticky notes, form fields | Not drawn. |
| JavaScript in the PDF | Never run. |
| An image over 50 megapixels | Left out of the slide. Prepare says so, and so does the contact sheet. |
| Shape | A 4:3 or portrait page gets bars at its sides, in the colour of its edge. |

### Legibility

The meeting gets a shared screen of 1280x720, which the platform compresses, and people often watch it small. Prepare warns about text that renders under 20 px on that image. For body text, aim for at least 24 px: about 18 pt on a 16:9 PowerPoint slide, or 13.5 pt on a Google Slides one. Make titles at least 40 px and bold (30 pt in PowerPoint), and avoid thin font weights.

## Preparing a deck

```bash
npm run slides -- prepare decks/q4-roadmap.pdf
npm run slides -- prepare decks/q4-roadmap.pdf --exclude 3,9
npm run slides -- prepare decks/q4-roadmap.pdf --label "Q4 plan"
```

It prints what it made:

```
Prepared q4-roadmap-k7m2qa: 12 pages rendered (2 excluded) from q4-roadmap.pdf.
Script: decks/q4-roadmap.script.md (new): 12 sections to write (TODO).
  pages 4, 7-9: the slide has text under 20 px, which may be hard to read in a small share window.
  page 5 has no text, so it can be answered about only from your script.
Contact sheet: data/decks/q4-roadmap-k7m2qa/sheet.html
Next: write the sections (or ask your Claude Code session to draft them), then
  npm run slides -- check decks/q4-roadmap.script.md
```

- **The deck** goes into `data/decks/<id>/`: one 1280x720 WebP image per page, `manifest.json` (each slide's title and text, for Alex's answers about the slide on screen, and what prepare noticed about it), and `sheet.html`, the contact sheet. The id is the file's name and six random letters: a handle on your computer, not a secret. The deck holds no speaker notes, and not the PDF's path: of its script, only a mark made with a key kept in `data/decks`, so check can tell the deck's own script from any other file.
- **`--exclude 3,9`** (or `4-6`) leaves pages out completely: they are never rendered, and nothing of them is kept in the deck or in a new script. Use it for a slide whose text must not appear anywhere. Give it on every prepare of that deck: a page prepared again without it is rendered again. In a script written before, prepare takes out its own notes of the slide's text, and the heading's title if it is the slide's, but keeps your paragraphs and any heading you wrote: delete them if they must not be kept.
- **`--label`** names the deck, and its id, instead of the file's name.
- **The script** is written next to the PDF: `decks/q4-roadmap.pdf` gets `decks/q4-roadmap.script.md`, readable only by you. Keep both in `decks/` (gitignored) or outside this folder. If it is already there, prepare updates it instead (see [After you change the deck](#after-you-change-the-deck)).
- A deck of 30 slides takes a few seconds. A PDF may have at most 100 pages and 100 MiB, a page's image at most 2 MiB (prepare lowers the quality a little first, and says so), and all a deck's images together at most 40 MiB. A long deck of detailed photos can reach that: prepare stops at the page that goes over, and says so. Export it again with lighter images, split it, or leave some pages out with `--exclude`. Prepare stops a PDF that takes more than 3 minutes.

## Writing the script

The script is the only source of what Alex says over your slides: the paragraphs, word for word. Alex never makes up narration. Its answers to questions come from your brief and your slides, as in any meeting.

```markdown
---
deck: q4-roadmap-k7m2qa      # written by prepare: don't change it
title: Q4 roadmap
minutes: 15
---

## 1 · Q4 roadmap

Hello everyone. I'll walk you through what ships this quarter and what it costs.
If you have a question at any point, say my name and I'll stop.

## 3 · What ships
hold: 3s

There's a lot on this slide, so I'll pick out the three things that matter most.

## 6 · Pricing
pause: 5s

Team is twelve dollars per user per month, and Business is twenty-nine. Any questions on pricing before I move on?

## 9 · Security details
on-request: yes

Here are the details of our security certifications.

## 11 · Customer list
exclude: yes
```

- **The front matter:** `deck` is the prepared deck's id (prepare writes it). `title` names the presentation. `minutes` is how long you have: check compares its estimate with it. A `#` after a space starts a comment there, so write "No. 2" or "#2", with no space before the `#`.
- **One section per slide**, headed `## <page> · <title>`, with the PDF page number (`-`, `–` or `:` work in place of `·`). Sections run in page order. The title in the heading is yours, and Alex says it after answering a question: "Back to <title>." (with no title, "Back to slide 6."). Write it as it is spoken: `check` warns about figures, signs and abbreviations in it, as in the narration. Prepare starts it from the slide's own title.
- **Keys go directly under the heading. Then a blank line, then what Alex says.** A line such as `Note: ...` under a heading is an unknown key: an error, never spoken and never dropped.
- **Paragraphs** are separated by blank lines. You can wrap a paragraph over several lines: Alex says it in whole sentences all the same.
- **Write figures as they are spoken:** "twelve dollars", not "$12"; "eighteen percent", not "18%". Check warns about signs, figures and abbreviations, and about figures that aren't on the slide.
- **Not speech, so refused:** lists, tables, links' addresses, URLs and HTML. Bold and italics are fine, and are dropped.
- **Comments** (`<!-- like this -->`) are for you. They are stripped before the script is ever sent, so the voice service and the meeting never see them. Your Claude Code session does, whenever it reads the file. Keep presenter-only remarks ("don't quote discounts") in comments, never in the paragraphs.

| Key | Meaning |
| --- | --- |
| `hold: 3s` | Extra seconds on the slide before Alex speaks, for reading (0 to 30). With no paragraphs, a silent slide. |
| `pause: 5s` | Silence after the last sentence (0 to 60). If that sentence is a question, people can answer it without saying Alex's name. |
| `on-request: yes` | A backup slide: not presented in order, but shown when someone asks for it ("go to slide 9"). |
| `exclude: yes` | Never shown, and never sent to the meeting. The same as having no section. |
| `check: yes` | Drafted, not yet read by you. Prepare writes it on every new section. Delete it once you have read the section. A warning only. |
| `check: changed` | The slide changed after this section was written, or moved. An error until you have read the section against the slide and deleted the line. In an excluded section too: the slide on its page changed since you excluded it. |

The skeleton prepare writes has each section ready: `check: yes`, then `TODO` where the paragraphs go, and the slide's own text in a comment (`<!-- On the slide: "..." -->`), with its page label and your Marp notes if the PDF has them. A `TODO` left in a section is an error, unless the section has `exclude: yes`.

Limits: 40,000 characters of script without its comments (about 45 minutes), 4,000 for one section, 400 for one sentence, and 100 sections.

### Asking your Claude Code session to draft it

Ask the session to draft the TODO sections from your slides: "draft the narration in decks/q4-roadmap.script.md from decks/q4-roadmap.pdf". It can read the PDF, and the slide text in the skeleton's comments. Ask it to write figures as words, to use only what is on the slides or in your words, and to leave `check: yes` on every section it drafts. Then read each section yourself, change what you want, and delete its `check: yes`. Nothing enforces that you have read a draft: check warns about every section still marked `check: yes`.

The session sees the whole file, comments included, when it reads it, and the PDF when it drafts from it: that goes to Anthropic under your Claude account, as everything the session reads does.

`npm run slides -- prepare` reads any PDF it is given and writes its text into `data/decks`, and `check` opens the file it is given itself (so your deny rules don't apply to it) and writes the deck's contact sheet. So both ask you before your session runs them, and the prompt shows you the path: don't allow `Bash(npm run slides:*)` or `Bash(npm run slides -- check:*)`. At most, allow `Bash(npm run slides -- list)`. The committed `.claude/settings.json` stops a session reading `data/decks` itself: it never needs to (see [Your Claude Code session](claude-code.md)).

## Checking the script

```bash
npm run slides -- check decks/q4-roadmap.script.md
```

It needs no key and no network. It reads only a file named `<something>.script.md`, and never prints a line of it but the paragraphs' figures and abbreviations. It loads the script's deck, and prints:
- **Errors**, which a script must not have: a missing or broken deck, a section for a page the deck doesn't have (or that was left out with `--exclude`), `TODO` or nothing to say (without `hold`), an unknown key, `check: changed`, a list, URL or HTML, the limits above, and no slide to present at all.
- **Warnings**, which never stop it: sections marked `check: yes`; signs, figures and abbreviations the voice may read wrongly; figures that aren't on the slide; a section over two minutes, or one so short people can't read the slide (add `hold`); narration over 70% of your `minutes`; pages with no section ("page 9 has no section, so it won't be shown"); and what prepare noticed about the slides: small text, no text, bars, a document page, an image left out or not drawn, one line for each with its pages.
- **The estimate:** how long the narration takes, from its length at about 150 words a minute, with the pauses around each slide. A section still `TODO` is not counted: it says how many are left to write. The real timing is known only in a meeting.

It exits with 1 while the script has errors, and 0 once it has none.

Only the script prepare wrote for the deck (the one beside its PDF) is compared with the slides' figures, refreshes the contact sheet, and counts as a use of the deck. Any other file that names the deck gets its other errors and warnings, and a line that says so: prepare the deck again from the PDF beside it. A script whose structure is unclear (two sections for one page, say) is not compared either, and leaves the contact sheet as it was, until it is fixed.

### The contact sheet

`data/decks/<id>/sheet.html`: open it in a browser. It shows every slide at half size, exactly as the meeting will see it, with its title, what prepare noticed, and, once check has run, what the script does with it (narrated, on request, excluded, or no section), the estimate, the narration, and the script's errors and warnings for that slide. It is a static page, with no script, that loads nothing from outside its folder. Prepare writes it. Check refreshes it only for the deck's own script, once that script's structure is clear: for any other file, or while the structure is unclear, the sheet is left as it was, so it can show an older version of the script. Its count of warnings is the one check prints.

## Presenting in a meeting

### Joining with slides

```bash
npm run join -- "<meeting link>" --slides decks/q4-roadmap.script.md
npm run join -- "<meeting link>" --slides decks/q4-roadmap.script.md --from 6     # start at slide 6
npm run join -- "<meeting link>" --slides decks/q4-roadmap.script.md --brief decks/acme.md
```

Or ask your Claude Code session: "send Alex into this meeting with the Q4 slides: <link>". It reads the script with its own Read tool and passes its text to `join_meeting` as `slides` (and `slides_from` for `--from`): never a path.

Before anything is sent, `npm run join` (or the channel) checks the script as `check` does, against its prepared deck: any error refuses the join, `check: changed` included, so narration written for an old slide is never presented over a new one. Then it sends only the script's canonical text: the front matter, the headings, the keys and the paragraphs, with every comment taken out. Your comments, Marp notes and "On the slide" text never reach the voice service or the meeting; the service refuses a script that still has a comment in it. It checks the script again, reads the slides the script shows (and only those: an excluded slide's image never leaves `data/decks`), and refuses the join before any bot is created when the platform is not in `SLIDES_PLATFORMS`, the deck is gone or can't be used, or the script has an error. A service older than the command says it can't present slides: restart it.

What it prints:

```
Alex is joining (bot 1f2e...).
It has "Q4 roadmap": 9 slides to present, about 9 min of your 15 min. It starts when someone says "Alex, start the presentation", or when you start it (npm run slides -- control start, or slides_control in Claude Code). Before then, make sure Alex may share its screen. Zoom: "Who can share?" set to "All participants" (in the meeting, the arrow beside Share, then Advanced sharing options). (npm run slides -- status and control take --meeting 1f2e... while it is in more than one meeting with slides.)
```

The meeting gets a chat notice that says Alex will present slides when asked, and how to pause them, and a consent line that says how to start them:

> Hello, I'm Alex, Sam's AI assistant. I'm transcribing this meeting so I can answer questions when you say my name. I also have slides to present for Sam: say "Alex, start the presentation" when you're ready. Otherwise I'll only speak when asked, and I can't agree to anything for Sam. If you'd like me to leave, say "Alex, please leave", or remove me from the participant list.

Nothing is shared until the presentation starts. Alex's camera tile is as it always is. A meeting joined without slides is exactly as it was.

### What the meeting sees and hears

When someone says "Alex, start the presentation" (or you start it), Alex:
1. says "I'm sharing my slides now. They can take a few seconds to appear.", and asks Recall to share its slides page as its screen;
2. waits up to 20 seconds for the page to show the first slide;
3. the first time in a meeting, and again on the next start after a "no", asks "Can everyone see my slides?". A "no" ("no", "not yet", "we can't see them", "I don't see anything", "it's just black") gets the setting the host needs to change, and the share stops. "Hold on" or "wait" gives it a moment: the slides may still be loading for them. A yes ("yes, we can see them") carries on at once, and so do a few seconds of quiet after the question has played; anything else is answered, then it carries on. A "no" said just as the script begins still stops it. Anything that holds the slides before the question (a pause, a question, the camera page reconnecting) asks it once that is over;
4. says your script, one sentence at a time, and changes slides only after the last sentence of a slide has played and the room is quiet for a moment. It talks about a slide only once the page has shown it.

The slides fill the shared screen, exactly as on the contact sheet, with no badge or overlay. The page's own frames ("about to present", "Slides paused", ended) say that Alex is an AI. After the last slide it takes questions, with that slide still up; two minutes with nothing said to it, and the share stops quietly. "Alex, start the presentation" puts it back.

### What the room can say

Anyone who says the name may start, pause, carry on, move between the slides you chose and stop sharing. "Alex, please leave" always wins, at any moment.

| Say | What happens |
| --- | --- |
| "Alex, start the presentation" (or "begin the slides", "present your slides", "start presenting") | It starts, from where it stopped if it had started before. |
| "Alex, next slide" | The next slide in order. |
| "Alex, go back" | The slide before, out of order: "Here's slide 4.", and it waits there. "Next" and "go back" step over backup slides (`on-request: yes`): those come only when asked for by number. |
| "Alex, go to slide 9" (or "show slide 9", "the last slide") | A slide behind, or a backup slide (`on-request: yes`), is shown out of order; one ahead is moved to, skipping the ones between. An excluded slide gets "I don't have slide 9 to show." |
| "Alex, go through that slide again" | The slide on screen, from its start. |
| "Alex, pause" (or "wait", "hold on", "one moment") | It stops at that sentence, and waits. |
| "Alex, carry on" (or "continue", "go on", "back to the slides") | It carries on from where it stopped: back on the slide it was presenting if it had shown another, with "Back to <title>." |
| "Alex, stop presenting" (or "stop sharing", "that's enough slides") | "Sure, I'll stop sharing my slides.", and the share stops. It keeps its place. |
| A question by name ("Alex, what does the Business plan cost?") | It stops at that sentence, answers in a few sentences, then says "Back to <title>." and the sentence again. |
| Talking over it, not to it | It stops at that sentence. Once the room is quiet: "Shall I carry on?"; yes, or silence, carries on with that sentence; "no" or "wait" waits for "carry on". |

Slide commands are never questions: they are not in the minutes' "Asked of Alex", nor sent to your session. "Next slide" without the name, "Next slide, Alex" (the name last), "Alex stopped at slide four" and "Alex, go back to the pricing and tell me the cost" (a question) are not commands. "Go to slide 5" before the presentation has started is not one either: start it first. Without the name, a command is read only just after one of Alex's own slide questions ("Shall I carry on?", or a slide's `pause:` question), or after someone says just "Alex?": "Go ahead." in reply to an answer that ended on a question is a reply to Alex, and is answered.

### What you can do

From your Claude Code session (`slides_status` and `slides_control`), or the terminal:

```bash
npm run slides -- status
npm run slides -- control pause
npm run slides -- control goto 6
npm run slides -- control end --meeting <bot id>
```

| Action | What happens |
| --- | --- |
| `start` | As "Alex, start the presentation". |
| `pause`, `resume` | Your pause is yours: only you can resume it. Someone saying "Alex, carry on", "yes" to "Shall I carry on?", or "start this slide again" gets "I'll wait for Sam on that." The room can still move between slides and stop sharing. A stop keeps your pause, so "Alex, start the presentation" then gets the same answer: use `start` (`resume` does nothing once the slides are stopped). |
| `next`, `back`, `goto N`, `restart` | As the room's, at once, and said aloud ("Moving to slide 6.", or "Going through slide 6 again." for the slide it is presenting), since the meeting didn't hear you ask. |
| `wrap_up` | "Let me jump to the last slide.", and the last slide in order. Yours only. |
| `stop` | As "Alex, stop presenting", but said as "I'll stop sharing my slides now.", since nobody in the meeting asked. |
| `end` | Stops it for good in this meeting, with the same line: the room can't start it again. Yours only. |

Without `--meeting` (or `meeting`), they act on the only meeting with slides, and are refused while there are several. `status` says where it stands: the state, the slide on screen, the slide it carries on from, and the share. Until Alex is in the meeting (it is joining, or in a waiting room), they say it has the slides but is not in yet.

Your session also gets a `presentation` event when the presentation starts, finishes or stops, and when something goes wrong (below), never one per slide. When the meeting ends, `meeting_ended` says how far it got (`presentation: {reached, of, finished}`), so you can join again with `--from`.

### When something goes wrong

| What happens | Alex says | Your session hears | What to do |
| --- | --- | --- | --- |
| Recall refused the share | "I couldn't share my slides." | `share_failed` | Try again; the log has Recall's status. A share is never asked for while Recall may still hold the last one: a start waits up to 20 s for Recall to take the last stop, and fails if it hasn't. |
| The page never showed the first slide | "My slides didn't load, so I've stopped sharing them." | `not_loading` | Check the tunnel; the log says how far it got. |
| Someone said they can't see the slides | The host setting to change | `not_seen` | The host changes it ([The platform settings](#the-platform-settings)); then "Alex, start the presentation". |
| The page stopped showing slides | "My slides seem stuck, so I've stopped sharing them." | `stuck` | Start it again. |
| Someone else took the page's link | "My slides had a problem, so I've stopped sharing them." | `contested` | No more shares in that meeting. |
| The camera page dropped just after a share started or stopped | Nothing more is shared in that meeting | `camera_suspect` | Take the platform out of `SLIDES_PLATFORMS` and run the share test again. |
| Shares asked for too often | "I'll leave the slides off for now." | `rate_limited` | Wait: at most one every 10 s, and 12 an hour. |
| Speech recognition lost | At the end of the sentence it is saying (what was queued after it isn't played, and it carries on from there): "I can't hear the meeting right now, so I'll pause my slides." Once it hears again: "Shall I carry on?" | `deaf` | Nothing: Alex never talks on when it can't hear "please leave". Your `resume` or a move meanwhile changes the slide in silence, and it carries on once it hears again. |
| ElevenLabs failed twice | "I'm having trouble with my voice; one moment." | `voice_failed` | "Alex, carry on", or `resume`. |
| Held for more than two minutes | Nothing | `held_long` | Resume it, or stop it. |

When Alex's camera page reconnects, the slides wait, and carry on two seconds after it is back with "Back to <title>." and the sentence. Your `resume` or a move meanwhile changes the slide in silence, and it carries on from there once the page is back. The slides page blanks itself to "Slides paused" about 12 seconds after it loses its link (the service stopped, or your computer slept), and to its ended frame after 75 seconds, so a slide never stays up without the service.

### The platform settings

| Platform | The setting |
| --- | --- |
| Zoom | "Who can share?" set to "All participants": in the meeting, the arrow beside Share, then Advanced sharing options. |
| Google Meet | Host controls: "Share their screen" on, or Host management off. If Alex still can't share, make it a co-host. |
| Microsoft Teams | Meeting options: "Who can present" includes everyone. Or make Alex a presenter: in People, the "..." beside its name, then Make a presenter. |

`SLIDES_PLATFORMS` lists where presenting is on at all: none unless set, and a platform only once [the share test](share-test.md) has passed there. A meeting with slides is left after a longer silence than other meetings, since Alex's own voice doesn't count as sound: your script's `minutes` plus 15, from 15 to 60 minutes (60 without `minutes`).

### What it doesn't do yet

- It doesn't notice when someone else starts sharing their screen: it narrates on until someone says "Alex, pause" or "Alex, stop presenting".
- It doesn't notice the host stopping its share either: say "Alex, stop presenting", then "Alex, start the presentation".
- It doesn't read PowerPoint's speaker notes, rehearse aloud, go to a slide by its title, or keep to a time budget.
- While it checks a question with your session, the slides wait.

### Where your slides go

- **Recall** shows the slides in the bot's browser while they are shared, and anyone with access to your Recall dashboard can watch them there through Remote DevTools. The bot's record keeps the page's address, with a token that dies when the share stops. Zero data retention covers the share: no recording of it is kept.
- **Your tunnel provider** carries the slide images in transit: only the slide on screen and its neighbours, never the whole deck.
- **The voice service** gets your script without its comments, and the slides it shows, in memory only, until the bot is out of the call.
- **Anthropic**, with each answer during the meeting: the outline (each slide's title and first sentence) and the slide on screen (your script for it and its text); with the minutes request, the presentation's title.
- **ElevenLabs** speaks your script.
- **Your Claude Code session** sees the script, comments included, when it reads it to send Alex in, and slide titles in its events, `slides_status` and the questions it is handed ("On screen: slide 6 (5th of 8 in this presentation), Pricing.").
- **The meeting**: anyone in it can screenshot or record what Alex shares.
- **The transcript** has your script as Alex said it, and `Slides:` lines saying which slide was on screen, as Alex's own lines: a talk to a room where nobody spoke gets no minutes. The minutes mention the presentation in one sentence, and never take your script for decisions or actions.
- "Alex, please leave" deletes the transcript as always, and blanks the slides before the goodbye. It doesn't delete the prepared deck: that is yours, on your computer before the meeting. `npm run slides -- delete` does.

## After you change the deck

Export the PDF again and run `prepare` on it again. It makes a new deck and updates the script beside the PDF:
- the `deck:` line gets the new id;
- a slide that moved (you inserted or deleted slides before it) is found by its text, or by its picture when it has no text or the same text as another slide. A slide repeated with the same text and picture is found by its order among its copies. Its section's heading is renumbered, with a comment saying so. A slide you edited where it was is compared there, between the slides around it. A section with `exclude: yes` follows its slide in the same way;
- a section whose slide is no longer in the deck gets `exclude: yes` (an `exclude: no` becomes yes, and an `on-request: yes` becomes a comment) and a comment saying the slide is gone. When the sections around it were renumbered, it also gets a number past the deck's last page, so the sections stay in page order. That slide never comes back: a new slide that later takes its number gets a section of its own, with `TODO`;
- if your sections would then be out of order (you moved slides around, or deleted one with no free number for its section, such as the first), the headings are left as they are. Each section whose slide moved, excluded or not, gets `check: changed` and a comment saying which page its slide is on now: move it there. A section whose slide is gone keeps its number. When that number is a page of the deck now, a comment says so: delete that section, or move it to the end and number it after the last slide. A new page whose number a section still has can't have a section yet: prepare names it, and quotes it in that section, which gets `check: changed`. Add a section for it once the other has moved;
- a section whose slide changed, in its text or its picture, gets `check: changed`, a comment saying so, and the slide's new text in a comment. It is an error until you have read the section against the slide and deleted the line, so narration written for the old slide is never presented over the new one. A section with `exclude: yes` is marked too, as you excluded the slide before: make sure it should still be left out. A re-export that changes a picture only slightly (a photo compressed again) marks it too: read it and delete the line;
- a new page gets a new section, with `TODO`;
- a section for a page you left out with `--exclude` gets `exclude: yes`, as above, and a comment saying it was left out. It also loses prepare's own comments quoting the slide, and its heading's title if it is the slide's;
- a page you left out with `--exclude` that is back in the deck, where the slides around it put it, loses the `exclude: yes` prepare gave its section (and its `on-request: yes` comes back). It gets `check: changed`, to be read again before it is shown: prepare never saw that slide, so it can't tell whether it is the one you left out;
- **your written paragraphs are never changed**, and every line you wrote stays where it was, but for a heading's page number or slide title as above;
- then the old deck is deleted.

Prepare compares each slide's text and picture with the old deck's. An unchanged page renders the same picture, so a slide with no text is found by it; a slide found by neither its text nor its picture is compared with the page the slides around it put it on. When the slides around it leave no page for it, its slide was deleted. If the old deck is gone already, or can't be used, it can't tell which slides changed, so it marks every section `check: changed`, but for the excluded ones (and deletes a deck that can't be used, as nothing would use it again). A script whose structure prepare can't follow (no front matter or `deck:` line, a comment left open, sections out of order) is never rewritten: prepare says what to fix, and renders nothing.

## Keeping and deleting decks

```bash
npm run slides -- list
npm run slides -- delete q4-roadmap-k7m2qa
npm run slides -- delete --all
```

- `data/decks` and each deck's folder are readable only by you (0700, files 0600). The loader refuses a deck that isn't: any file another user could read or write, a symbolic link, a file it doesn't expect, an image that isn't exactly what prepare made.
- A deck is deleted `DECK_RETENTION_DAYS` (30 unless set) after it was last used: prepared, checked, or sent into a meeting (a join the voice service took; `npm run join` checking it first, or a join the service refused, doesn't count). The voice service checks when it starts and every hour, with the transcripts. Your script is yours: nothing deletes it, and `prepare` makes the deck again from your PDF.
- `delete` deletes at once. `list` shows each deck, its slides, when it was last used, and when it will be deleted.
- While prepare runs, a copy of your PDF is in a temporary `data/decks/.tmp-*` folder, removed when it ends or when you stop it. If it was killed outright, the next prepare or `delete --all` removes that folder once it is 10 minutes old (`list` says when one is there).

## How a PDF is converted, and what that protects

A PDF you were sent can be hostile. Prepare reads it with pdf.js in a separate process, which:
- gets an environment made from scratch, with no API keys in it, and never loads `.env` itself;
- is stopped after 3 minutes, with anything it started, and when you stop prepare (Ctrl-C, or closing its terminal);
- never runs the PDF's JavaScript, and never fetches anything the PDF links to;
- writes images that prepare encodes itself, so no byte of your PDF reaches the meeting bot's image decoder.

That is not a sandbox: the process runs as you, so code that broke out of pdf.js could still read your files, `.env` included. Treat a PDF from someone you don't know as you would any file from them. [Ports and security](security.md) has the details.

`npm install` installs pdf.js and a native canvas library for this (about 73 MB more). On a computer that never prepares decks, `npm install --omit=optional` leaves the canvas out; prepare then says "Slide rendering needs @napi-rs/canvas: run npm install (without --omit=optional)", and everything else works.
