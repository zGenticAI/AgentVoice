// Where a meeting may have slides presented in it. Presenting is off on every platform until the owner turns one on in
// SLIDES_PLATFORMS, once the screen-share test has passed there (docs/share-test.md): whether a share mid-call leaves
// the camera page, and with it the assistant's voice and hearing, untouched is known only from a real meeting.
import { WORDS } from '../commands.ts'
import { type SlidesPlatform, config } from '../config.ts'
import { identity } from '../identity.ts'
import { PLATFORM_NAMES, type Platform } from '../recall.ts'

/**
 * Why a meeting on this platform can't be joined with slides, or '' when it can. Said before any bot is created, so a
 * refused join costs nothing. It names the platform, the test to run and the setting to change.
 */
export function slidesPlatformProblem(platform: Platform, enabled: readonly SlidesPlatform[] = config.slidesPlatforms): string {
  if (enabled.includes(platform)) return ''
  const name = PLATFORM_NAMES[platform]
  const now = enabled.length ? `it lists ${enabled.join(', ')}` : 'it lists none yet'
  return (
    `Presenting slides is off on ${name}. Run the screen-share test in a ${name} meeting you host first ` +
    `(${WORDS.doc('share-test')}). Once it passes, add ${platform} to SLIDES_PLATFORMS in ${WORDS.envFile} (${now}) and restart the service.`
  )
}

/**
 * Where the host lets the assistant share its screen, per platform, as docs/share-test.md lists them: said in the join's
 * note, so the host can set it before the presentation starts. Zoom's co-host is left out until a test shows a guest bot
 * can be made one.
 */
export function shareSetting(platform: Platform, name: string = identity.name): string {
  switch (platform) {
    case 'zoom':
      return 'Zoom: "Who can share?" set to "All participants" (in the meeting, the arrow beside Share, then Advanced sharing options).'
    case 'google_meet':
      return `Google Meet: Host controls, "Share their screen" on (or Host management off). If ${name} still can't share, make it a co-host.`
    case 'microsoft_teams':
      return `Microsoft Teams: Meeting options, "Who can present" includes everyone. Or make ${name} a presenter: in People, the "..." beside its name, then Make a presenter.`
  }
}

const duration = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/**
 * What the owner is told about the slides of a meeting just joined: which deck, how long, how it starts, and the share
 * setting to check. The deck's name is the owner's own, for the owner's terminal or session: never logged.
 */
export function slidesNote(
  deck: { name: string; narrated: number; totalMs: number; script: { minutes: number | null } },
  platform: Platform,
  name: string = identity.name,
): string {
  const of = deck.script.minutes ? ` of your ${deck.script.minutes} min` : ''
  const slides = `${deck.narrated} slide${deck.narrated === 1 ? '' : 's'} to present, about ${duration(deck.totalMs)}${of}`
  return (
    `It has "${deck.name}": ${slides}. It starts when someone says "${name}, start the presentation", or when you start it ` +
    `(${WORDS.run('slides', 'control start')}, or slides_control in your coding session). Before then, make sure ${name} may share its screen. ` +
    shareSetting(platform, name)
  )
}
