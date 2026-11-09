// Where the channel server puts meeting questions. No MCP in here, so it is easy to test.
//
// Channel notifications only reach the main Claude Code session, and only between its own
// tool calls. So the meeting-assistant agent pulls questions with the next_question tool
// instead. A question from Alex goes:
// - to a next_question call that is waiting for one;
// - else into a queue, while an assistant is attached (a next_question call returned less than
//   ATTACH_GRACE_MS ago, so it is answering the previous question and will ask again);
// - else to the main session as a channel notification, as before.
// A queued question nobody takes within ATTACH_GRACE_MS goes to the main session after all
// (the assistant has died). Each question is handed out once.
//
// An assistant may name its meeting (the key from join_meeting, or the `meeting` of its
// questions). It then takes only that meeting's questions, and hears that meeting's end however
// late it asks, even once another meeting has started. An assistant that names no meeting hears
// the end of the latest meeting, on every call, until another meeting starts or this session sends
// Alex into one. So an assistant that was busy when the meeting ended still finishes, and one
// started for the next meeting never acts on the previous meeting's end.

export const ATTACH_GRACE_MS = 45_000
// Ended meetings remembered for assistants that name theirs.
const ENDS_KEPT = 20
// Stands for the meeting join_meeting is sending Alex into, until it starts.
const JOINING = '\0joining'
// Attachment of an assistant that named no meeting.
const ANY = '\0any'

export interface Question {
  question_id: string
  asked_by: string
  question: string
  context: string
  meeting: string
}

export interface MeetingEnd {
  meeting: string
  /** '' once deleted at a participant's request. */
  transcript_file: string
  questions: string[]
  /** '' when there are no minutes: why is in no_minutes, or minutes_error if writing them failed. */
  minutes_file: string
  no_minutes?: string
  minutes_error?: string
}

export type Delivery = { question: Question } | { meeting_ended: MeetingEnd } | { none: true }

interface Waiter {
  meeting?: string
  until: number
  deliver: (d: Delivery) => void
}

/** True when an assistant for `wanted` (any meeting if undefined) takes a question from `meeting`. */
const takes = (wanted: string | undefined, meeting: string) => wanted === undefined || wanted === meeting

export class QuestionDesk {
  private waiters: Waiter[] = []
  private queue: { question: Question; timer: NodeJS.Timeout }[] = []
  private ends = new Map<string, MeetingEnd>()
  // The end of the latest meeting, until another one starts or is joined.
  private over: MeetingEnd | null = null
  // The meeting that started last, JOINING while join_meeting's meeting has not started, or null.
  private current: string | null = null
  // When a next_question call last returned, by the meeting it named (ANY for none).
  private returnedAt = new Map<string, number>()

  constructor(
    private toSession: (q: Question) => void,
    private graceMs = ATTACH_GRACE_MS,
  ) {}

  /** True while a meeting-assistant that takes this meeting's questions is waiting, or answering the last one. */
  attachedFor(meeting: string): boolean {
    if (this.waiters.some(w => takes(w.meeting, meeting))) return true
    const now = Date.now()
    for (const [key, at] of this.returnedAt) {
      if ((key === ANY || key === meeting) && now - at < this.graceMs) return true
    }
    return false
  }

  /** Until when (epoch ms) some assistant counts as attached, as things stand; 0 if none does. */
  get attachedUntil(): number {
    let until = 0
    for (const at of this.returnedAt.values()) until = Math.max(until, at + this.graceMs)
    for (const w of this.waiters) until = Math.max(until, w.until + this.graceMs)
    return until > Date.now() ? until : 0
  }

  /** True when next(…, meeting) would return at once. */
  ready(meeting?: string): boolean {
    return this.queue.some(item => takes(meeting, item.question.meeting)) || this.endFor(meeting) !== null
  }

  /** A question from Alex. */
  offer(question: Question): void {
    // A question means its meeting is live, whatever this desk last heard.
    if (this.over && this.over.meeting !== question.meeting) {
      this.over = null
      this.current = question.meeting
    }
    const waiter = this.waiters.find(w => takes(w.meeting, question.meeting))
    if (waiter) {
      this.waiters = this.waiters.filter(w => w !== waiter)
      return waiter.deliver({ question })
    }
    if (!this.attachedFor(question.meeting)) return this.toSession(question)
    const item = {
      question,
      timer: setTimeout(() => {
        if (!this.drop(item)) return
        this.toSession(question)
      }, this.graceMs).unref(),
    }
    this.queue.push(item)
  }

  /** join_meeting is sending Alex into a meeting (its key, if known): the last meeting's end no longer applies. */
  joining(meeting?: string): void {
    this.over = null
    this.current = meeting ?? JOINING
  }

  /** A meeting started: the last meeting's end no longer applies. */
  meetingStarted(meeting: string): void {
    this.over = null
    this.current = meeting
    this.ends.delete(meeting)
  }

  /** A meeting ended. Its assistant hears it on this and every later call. The main session is told separately. */
  meetingEnded(end: MeetingEnd): void {
    this.ends.delete(end.meeting)
    this.ends.set(end.meeting, end)
    for (const key of [...this.ends.keys()].slice(0, Math.max(0, this.ends.size - ENDS_KEPT))) this.ends.delete(key)
    // Unless a newer meeting has started or is being joined, this is now the latest meeting's end.
    const latest = this.current === null || this.current === end.meeting
    if (latest) {
      this.over = end
      this.current = null
    }
    // Its questions can no longer be answered aloud.
    for (const item of [...this.queue]) if (item.question.meeting === end.meeting) this.drop(item)
    for (const w of [...this.waiters]) {
      if (w.meeting === end.meeting || (w.meeting === undefined && latest)) {
        this.waiters = this.waiters.filter(x => x !== w)
        w.deliver({ meeting_ended: end })
      }
    }
  }

  /**
   * For next_question: the oldest queued question (of `meeting`, if named), else the end of the
   * meeting, else whatever arrives within waitMs, else { none: true }. A cancelled call (signal)
   * takes nothing.
   */
  next(waitMs: number, signal?: AbortSignal, meeting?: string): Promise<Delivery> {
    // Checked first: a call cancelled before it started must not take a queued question, which would then be lost.
    if (signal?.aborted) return Promise.resolve({ none: true })
    const now = this.take(meeting)
    if (now) return Promise.resolve(this.returned(now, meeting))
    return new Promise(resolve => {
      let done = false
      const finish = (d: Delivery, cancelled = false) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters = this.waiters.filter(w => w !== waiter)
        resolve(cancelled ? d : this.returned(d, meeting))
      }
      const onAbort = () => finish({ none: true }, true)
      const timer = setTimeout(() => finish({ none: true }), waitMs).unref()
      const waiter: Waiter = { meeting, until: Date.now() + waitMs, deliver: d => finish(d) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private endFor(meeting: string | undefined): MeetingEnd | null {
    return meeting === undefined ? this.over : (this.ends.get(meeting) ?? null)
  }

  private take(meeting: string | undefined): Delivery | null {
    const item = this.queue.find(i => takes(meeting, i.question.meeting))
    if (item) {
      this.drop(item)
      return { question: item.question }
    }
    const end = this.endFor(meeting)
    return end ? { meeting_ended: end } : null
  }

  /** Removes a queued question and its timer. False if it was no longer queued. */
  private drop(item: { question: Question; timer: NodeJS.Timeout }): boolean {
    const i = this.queue.indexOf(item)
    if (i < 0) return false
    clearTimeout(item.timer)
    this.queue.splice(i, 1)
    return true
  }

  /** Notes that a call returned, so the assistant counts as attached for a while. */
  private returned(d: Delivery, meeting: string | undefined): Delivery {
    const key = meeting ?? ANY
    // Once it has the end of the meeting, the assistant finishes: it is no longer attached.
    if ('meeting_ended' in d) this.returnedAt.delete(key)
    else this.returnedAt.set(key, Date.now())
    return d
  }
}
