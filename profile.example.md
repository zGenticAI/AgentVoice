# Profile

<!-- Copy this file to profile.md (or point PROFILE_FILE in .env at your own copy) and make it yours. profile.md is
     gitignored: it is yours, and it may name private paths. These notes are comments, left out when it is read, so
     they can stay.

     Only the five "## " sections below are read; any other "## " heading is ignored, with a warning (npm run check
     lists the sections it found). Leave a section out, or empty, for its generic default. Short values that go into
     sentences (your name, your full name, your company) are in .env: OWNER_NAME, OWNER_FULL_NAME, COMPANY_NAME. -->

## About

<!-- One to three sentences of standing context about you and your work. The assistant's spoken answers start from
     it, in every meeting, so keep it short and fit for anyone you meet. Without it: "<OWNER_NAME> works at
     <COMPANY_NAME>." when a company is set, else nothing. -->
Sam runs Acme, a small company that builds scheduling software for clinics.

## Hand to the session

<!-- The questions the assistant hands to your Claude Code session rather than answering from the brief: one line,
     or a list. Without it: current work, repos, documents, decisions, plans, design detail, positioning or how it
     compares with other products. -->
current work, repos, documents, decisions, plans, design detail, the product roadmap, or how Acme compares with other products

## Knowledge sources

<!-- Where the meeting-assistant agent looks, read only, in this order, after the brief: a path, what it is for, and
     any rule for that source. The agent gets this from the zoom-meeting get_profile tool. Folders outside the
     project need read access in Claude Code (docs/claude-code.md: "The meeting assistant"). Without it, the agent answers from
     the brief alone. -->
- `~/work/acme-docs/overview.md`: what Acme's product does, for questions about the product.
- The newest `~/work/acme-docs/status/status-*.md`: current status of the work.
- `~/work/acme-website/src/`: the public website copy, for positioning. Use only what is already published there.

## Never share

<!-- Standing rules on what the session and its agent never say or post in a meeting, on top of their own (no
     credentials, hostnames, security findings, other people's or clients' information). They can only add. -->
- Customer names, unless the brief says they may be shared.
- Revenue, pricing and contract terms.

## Never open

<!-- More paths the agent must never read, on top of its own (.env files, ~/.ssh, ~/.cloudflared, ~/.claude.json,
     anything named like a key, secret, token, credential or certificate). To enforce them, also add Read deny rules
     for them to .claude/settings.local.json (docs/claude-code.md: "The meeting assistant"). -->
- `~/work/acme-docs/hr/`
- `~/work/acme-ops/secrets/`
