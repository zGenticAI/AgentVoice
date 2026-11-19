# Presenting slides

How to prepare a slide deck for Alex to present: exporting it as a PDF, `npm run slides -- prepare`, writing the script Alex reads from, and `npm run slides -- check`. These pages call the assistant Alex, its default name, and you, its owner, Sam.

This version prepares and checks a deck on your computer. It needs no key and no network, and touches no meeting. Presenting it in a meeting (sharing the slides and narrating them) comes in a later version, and this page will cover it then.

## Before your first presentation

A meeting bot shares its screen only where the host allows it, and the setting differs on Zoom, Google Meet and Microsoft Teams. Run [the screen-share test](share-test.md) once on each platform you will present on.

## The steps

1. Export your deck as a PDF (below). The PDF keeps your fonts and layout exactly.
2. `npm run slides -- prepare deck.pdf`. It makes one image per slide, and writes `deck.script.md` next to your PDF, with a section for each slide.
3. Write what Alex should say in each section, or ask your Claude Code session to draft it, then read it yourself.
4. `npm run slides -- check deck.script.md`. It checks the script, estimates the time, and refreshes the contact sheet: every slide exactly as the meeting will see it.

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
npm run slides -- prepare deck.pdf
npm run slides -- prepare deck.pdf --exclude 3,9
npm run slides -- prepare deck.pdf --label "Q4 plan"
```

It prints what it made:

```
Prepared q4-roadmap-k7m2qa: 12 pages rendered (2 excluded) from q4-roadmap.pdf.
Script: q4-roadmap.script.md (new): 12 sections to write (TODO).
  page 4 has text under 20 px, which may be hard to read in a small share window.
  page 5 has no text, so it can be answered about only from your script.
Contact sheet: data/decks/q4-roadmap-k7m2qa/sheet.html
Next: write the sections (or ask your Claude Code session to draft them), then
  npm run slides -- check q4-roadmap.script.md
```

- **The deck** goes into `data/decks/<id>/`: one 1280x720 WebP image per page, `manifest.json` (each slide's title and text, for Alex's answers about the slide on screen, and what prepare noticed about it), and `sheet.html`, the contact sheet. The id is the file's name and six random letters: a handle on your computer, not a secret. The deck holds no speaker notes, and not the PDF's path: of its script, only a mark made with a key kept in `data/decks`, so check can tell the deck's own script from any other file.
- **`--exclude 3,9`** (or `4-6`) leaves pages out completely: they are never rendered, and nothing of them is kept. Use it for a slide whose text must not appear anywhere.
- **`--label`** names the deck, and its id, instead of the file's name.
- **The script** is written next to the PDF: `deck.pdf` gets `deck.script.md`, readable only by you. If it is already there, prepare updates it instead (see [After you change the deck](#after-you-change-the-deck)).
- A deck of 30 slides takes a few seconds. A PDF may have at most 100 pages and 100 MiB, and a page's image at most 2 MiB (prepare lowers the quality a little first, and says so). Prepare stops a PDF that takes more than 3 minutes.

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

- **The front matter:** `deck` is the prepared deck's id (prepare writes it). `title` names the presentation. `minutes` is how long you have: check compares its estimate with it.
- **One section per slide**, headed `## <page> · <title>`, with the PDF page number (`-`, `–` or `:` work in place of `·`). Sections run in page order. The title in the heading is for you.
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
| `check: changed` | The slide changed after this section was written. An error until you have read the section against the slide and deleted the line. |

The skeleton prepare writes has each section ready: `check: yes`, then `TODO` where the paragraphs go, and the slide's own text in a comment (`<!-- On the slide: "..." -->`), with its page label and your Marp notes if the PDF has them. A `TODO` left in a section is an error, unless the section has `exclude: yes`.

Limits: 40,000 characters of script without its comments (about 45 minutes), 4,000 for one section, 400 for one sentence, and 100 sections.

### Asking your Claude Code session to draft it

Ask the session to draft the TODO sections from your slides: "draft the narration in q4-roadmap.script.md from q4-roadmap.pdf". It can read the PDF, and the slide text in the skeleton's comments. Ask it to write figures as words, to use only what is on the slides or in your words, and to leave `check: yes` on every section it drafts. Then read each section yourself, change what you want, and delete its `check: yes`. Nothing enforces that you have read a draft: check warns about every section still marked `check: yes`.

The session sees the whole file, comments included, when it reads it, and the PDF when it drafts from it: that goes to Anthropic under your Claude account, as everything the session reads does.

`npm run slides -- prepare` reads any PDF it is given and writes its text into `data/decks`, and `check` opens the file it is given itself (so your deny rules don't apply to it) and writes the deck's contact sheet. So both ask you before your session runs them, and the prompt shows you the path: don't allow `Bash(npm run slides:*)` or `Bash(npm run slides -- check:*)`. At most, allow `Bash(npm run slides -- list)`. The committed `.claude/settings.json` stops a session reading `data/decks` itself: it never needs to (see [Your Claude Code session](claude-code.md)).

## Checking the script

```bash
npm run slides -- check deck.script.md
```

It needs no key and no network. It reads only a file named `<something>.script.md`, and never prints a line of it but the paragraphs' figures and abbreviations. It loads the script's deck, and prints:
- **Errors**, which a script must not have: a missing or broken deck, a section for a page the deck doesn't have (or that was left out with `--exclude`), `TODO` or nothing to say (without `hold`), an unknown key, `check: changed`, a list, URL or HTML, the limits above, and no slide to present at all.
- **Warnings**, which never stop it: sections marked `check: yes`; signs, figures and abbreviations the voice may read wrongly; figures that aren't on the slide; a section over two minutes, or one so short people can't read the slide (add `hold`); narration over 70% of your `minutes`; pages with no section ("page 9 has no section, so it won't be shown"); and what prepare noticed about the slides: small text, no text, bars, a document page, an image left out or not drawn.
- **The estimate:** how long the narration takes, from its length at about 150 words a minute, with the pauses around each slide. The real timing is known only in a meeting.

It exits with 1 while the script has errors, and 0 once it has none.

Only the script prepare wrote for the deck (the one beside its PDF) is compared with the slides' figures, refreshes the contact sheet, and counts as a use of the deck. Any other file that names the deck gets its other errors and warnings, and a line that says so: prepare the deck again from the PDF beside it. A script whose structure is unclear (two sections for one page, say) is not compared either, until it is fixed.

### The contact sheet

`data/decks/<id>/sheet.html`: open it in a browser. It shows every slide at half size, exactly as the meeting will see it, with its title, what prepare noticed, and, once check has run, what the script does with it (narrated, on request, excluded, or no section), the estimate, the narration, and the script's errors and warnings for that slide. It is a static page, with no script, that loads nothing from outside its folder. Check refreshes it every time.

## After you change the deck

Export the PDF again and run `prepare` on it again. It makes a new deck and updates the script beside the PDF:
- the `deck:` line gets the new id;
- a section whose slide's text changed gets `check: changed`, a comment saying so, and the slide's new text in a comment. It is an error until you have read the section against the slide and deleted the line, so narration written for the old slide is never presented over the new one;
- a new page gets a new section, with `TODO`;
- a section for a page that is gone (or that you left out with `--exclude`) gets `exclude: yes`;
- **your written paragraphs are never changed**, and every line you wrote stays where it was;
- then the old deck is deleted.

Prepare compares the slides' text with the old deck's. If the old deck is gone already, it can't tell which slides changed, so it marks every section `check: changed`. A script whose structure prepare can't follow (no front matter or `deck:` line, a comment left open, sections out of order) is never rewritten: prepare says what to fix, and renders nothing.

## Keeping and deleting decks

```bash
npm run slides -- list
npm run slides -- delete q4-roadmap-k7m2qa
npm run slides -- delete --all
```

- `data/decks` and each deck's folder are readable only by you (0700, files 0600). The loader refuses a deck that isn't: any file another user could read or write, a symbolic link, a file it doesn't expect, an image that isn't exactly what prepare made.
- A deck is deleted `DECK_RETENTION_DAYS` (30 unless set) after it was last used: prepared or checked. The voice service checks when it starts and every hour, with the transcripts. Your script is yours: nothing deletes it, and `prepare` makes the deck again from your PDF.
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
