// npm run slides -- status and control: the presentation in a meeting, through the running voice service's control
// socket (/api/slides). The only part of npm run slides that talks to anything: prepare, check, list and delete never
// load this module, so they reach no network code at all.
import { identity } from '../identity.ts'
import { controlCall, controlToken, unreachableText } from './control-call.ts'
import type { SlidesArgs } from './slides-args.ts'
import { presentationLines } from './slides-status.ts'

/** Asks the voice service, and gives the lines to print and the exit code. */
export async function runControl(args: Extract<SlidesArgs, { command: 'status' | 'control' }>): Promise<{ lines: string[]; code: number }> {
  const access = controlToken()
  if ('problem' in access) return { lines: [access.problem], code: 1 }
  const reply =
    args.command === 'status'
      ? await controlCall(access.token, 'GET', `/api/slides${args.meeting ? `?${new URLSearchParams({ meeting: args.meeting })}` : ''}`, '', 10_000)
      : await controlCall(access.token, 'POST', '/api/slides', JSON.stringify({ action: args.action, slide: args.slide, meeting: args.meeting }), 10_000)
  return reply instanceof Error ? { lines: [unreachableText(reply)], code: 1 } : presentationLines(reply, identity.name)
}
