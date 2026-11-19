// Where a meeting may have slides presented in it. Presenting is off on every platform until the owner turns one on in
// SLIDES_PLATFORMS, once the screen-share test has passed there (docs/share-test.md): whether a share mid-call leaves
// the camera page, and with it the assistant's voice and hearing, untouched is known only from a real meeting.
import { type SlidesPlatform, config } from '../config.ts'
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
    `(docs/share-test.md). Once it passes, add ${platform} to SLIDES_PLATFORMS in .env (${now}) and restart the service.`
  )
}
