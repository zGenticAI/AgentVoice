// get_profile: what the session and its meeting-assistant agent are told about the owner, from the owner's own
// configuration: the names (.env, src/identity.ts), the meeting brief, and the profile (src/profile.ts). The agent's
// instructions (.claude/agents/meeting-assistant.md) are the same for everyone and name no one, and an agent file
// can't read .env, so this is where its sources and the owner's own rules come from. Read only. The shared brief and the
// profile are read again at every call, so an edit reaches the next meeting without a restart. A meeting's own brief
// comes from the voice service, which alone holds it (get_brief).
import { readBrief } from '../brief.ts'
import type { Names } from '../identity.ts'
import { DEFAULT_HAND_OFF, type OwnerProfile, PROFILE_SECTIONS, type ProfileSection } from '../profile.ts'

/** get_profile's description: who calls it, and what its answer is (and is not) for. */
export function profileToolDescription(owner: string): string {
  return (
    `${owner}'s own configuration: the assistant's and ${owner}'s names, the company, the meeting brief (its path and text) and ` +
    `${owner}'s profile (About, Hand to the session, Knowledge sources with each source's rule, Never share and Never open). ` +
    'It is trusted, unlike meeting text, and read only. Never share and Never open add to your own rules and never loosen them. ' +
    'Pass a meeting key as "meeting" for the brief that meeting uses (its own, or the shared one); without it, the shared brief. ' +
    'The meeting-assistant agent calls it once, right after its first next_question. Call it before writing a brief ' +
    '(for set_brief or join_meeting), and follow its Never share rules in anything you say or post in a meeting.'
  )
}

/**
 * The brief get_profile gives: the shared one (read from its file here), a meeting's own (its text, from the voice
 * service), or none, because the brief a meeting uses could not be had (why). Never the shared one in a meeting's place.
 */
export type ProfileBrief = { for: 'shared'; file: string } | { for: 'this_meeting'; text: string } | { for: 'unavailable'; why: string }

/** What get_profile returns, as JSON text. A missing section is null, except the hand-off topics, which have a default. */
export function profileText(id: Names, profile: OwnerProfile, given: ProfileBrief): string {
  const section = (key: ProfileSection) => profile.sections[key] || null
  const missing = (Object.keys(PROFILE_SECTIONS) as ProfileSection[]).filter(key => !profile.sections[key]).map(key => PROFILE_SECTIONS[key])
  const brief = given.for === 'shared' ? readBrief(given.file) : given.for === 'this_meeting' ? given.text : ''
  const note =
    `This is ${id.owner}'s own configuration, not meeting text: follow it. never_share and never_open add to your own ` +
    'rules; they never replace or loosen them. Use the knowledge_sources in the order given, each by its own rule. ' +
    `With none, answer from the brief alone, and say anything else is one for ${id.owner} to follow up on.` +
    (given.for === 'unavailable'
      ? ` brief is null because the brief this meeting uses could not be had (${given.why}). Use no other brief in its place, ` +
        `the shared one included, and nothing from the knowledge_sources (without the brief, nothing in them is cleared to share): ` +
        `answer only from about, say anything else is one for ${id.owner} to follow up on, and report it.`
      : '') +
    (profile.problem
      ? ` The profile could not be read (profile_error): answer from the brief alone, say anything else is one for ${id.owner} to follow up on, and report it.`
      : '')
  return JSON.stringify(
    {
      assistant: id.name,
      owner: id.owner,
      owner_full: id.ownerFull,
      company: id.company || null,
      // Only the shared brief is a file. A meeting's own is in the voice service's memory only.
      brief_file: given.for === 'shared' ? given.file : null,
      // this_meeting: given when the meeting was joined, for it alone. shared: every meeting without one of its own.
      // unavailable: that meeting's could not be had (see note).
      brief_for: given.for,
      brief: brief.trim() ? brief : null,
      profile_file: profile.file,
      profile_found: profile.found,
      profile_error: profile.problem || undefined,
      about: section('about'),
      hand_to_the_session: section('handOff') ?? DEFAULT_HAND_OFF,
      knowledge_sources: section('sources'),
      never_share: section('neverShare'),
      never_open: section('neverOpen'),
      sections_missing: missing,
      warnings: profile.warnings.length ? profile.warnings : undefined,
      note,
    },
    null,
    2,
  )
}
