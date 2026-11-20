/**
 * toks — tok/s display for each conversation (opencode v1 TUI plugin)
 *
 * Shows generation throughput on a dedicated line at the bottom of the
 * screen (the `app_bottom` slot — its own row, so long metrics never
 * squeeze the prompt's agent/model row):
 *   ⏳ 1.4s waiting for first token                  (pre-first-token)
 *   ⚡ ~12.4 tok/s · 8.2s                             (live estimate + elapsed)
 *   ⚡ 41.3 tok/s · ttft 0.3s · total 6.2s · ↑12.3k ↓8.5k   (last task)
 *
 * `/toks` opens a dialog with per-task history:
 *   time · model · steps · tok/s, plus ttft, total and gen durations,
 *   input (cache read) and output tokens, e2e rate and cost.
 *
 * Measurement (all from server events, no estimates in final numbers):
 *   - generation tokens  = step-finish tokens.output + tokens.reasoning
 *     (opencode's tokens.output EXCLUDES reasoning — the two must be summed)
 *   - input/cache tokens = summed across a reply's steps (one LLM call each);
 *     the assistant message's own tokens field only reflects the LAST step
 *   - ttft  = user send → first streamed token; anchored on the user
 *     message's creation time when the event is observed, else the assistant
 *     message's creation time
 *   - total  = user send → assistant completion (includes TTFT, tool gaps)
 *   - gen window = first streaming part activity → last streaming part
 *     activity within a step (excludes TTFT and tool-execution gaps)
 *   - a task (one user send) groups all its assistant messages; tool-call
 *     JSON streams count as generation because step tokens include them
 *
 * Diagnostics: TOKS_DEBUG=/path/to/file appends one line per event.
 *
 * Install: copy to ~/.opencode/plugins/ (or another scanned plugins dir) and add
 * the file path to the "plugin" array in ~/.config/opencode/tui.json.
 */
import { appendFileSync } from "node:fs"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in toks.test.ts)
// ---------------------------------------------------------------------------

export type StepMetrics = {
  stepStartAt: number
  firstTokenAt?: number
  lastTokenAt?: number
  chars: number
  genTokens?: number
  finishedAt?: number
}

export type ReplyMetrics = {
  messageID: string
  model: string
  agent: string
  createdAt: number
  sentAt?: number
  /** assistant messages of one user send share a task (tool rounds continue the same task) */
  taskSeq?: number
  completedAt?: number
  cost: number
  inputTokens: number
  cacheReadTokens: number
  steps: StepMetrics[]
}

export type ReplySummary = {
  messageID: string
  model: string
  agent: string
  createdAt: number
  completedAt?: number
  cost: number
  inputTokens: number
  cacheReadTokens: number
  steps: number
  genTokens: number
  genMs: number
  ttftMs: number
  totalMs?: number
  tokS?: number
  e2eTokS?: number
}

/** tokens/second over a generation window; undefined when the window is unusable */
export function tokensPerSecond(tokens: number, windowMs: number): number | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined
  // sub-100ms windows are SSE-batching artifacts, not real throughput
  if (windowMs < 100) return undefined
  return tokens / (windowMs / 1000)
}

/** rough live estimate while streaming: ~4 chars per token */
export function estimateTokensPerSecond(chars: number, windowMs: number): number | undefined {
  return tokensPerSecond(chars / 4, windowMs)
}

/** collapse a reply's steps into one summary */
export function summarizeReply(reply: ReplyMetrics): ReplySummary {
  const finished = reply.steps.filter((s) => s.genTokens !== undefined)
  const genTokens = finished.reduce((acc, s) => acc + (s.genTokens ?? 0), 0)
  const genMs = finished.reduce((acc, s) => {
    const first = s.firstTokenAt
    const last = s.lastTokenAt
    if (first === undefined || last === undefined || last <= first) return acc
    return acc + (last - first)
  }, 0)
  const sentAt = reply.sentAt ?? reply.createdAt
  const firstStep = finished[0]
  const ttftMs = firstStep?.firstTokenAt !== undefined ? Math.max(0, firstStep.firstTokenAt - sentAt) : 0
  const totalMs =
    reply.completedAt !== undefined && sentAt > 0 ? Math.max(0, reply.completedAt - sentAt) : undefined
  return {
    messageID: reply.messageID,
    model: reply.model,
    agent: reply.agent,
    createdAt: reply.createdAt,
    completedAt: reply.completedAt,
    cost: reply.cost,
    inputTokens: reply.inputTokens,
    cacheReadTokens: reply.cacheReadTokens,
    steps: finished.length,
    genTokens,
    genMs,
    ttftMs,
    totalMs,
    tokS: tokensPerSecond(genTokens, genMs),
    e2eTokS: totalMs !== undefined ? tokensPerSecond(genTokens, totalMs) : undefined,
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 10_000) return (n / 1000).toFixed(1) + "k"
  return n.toLocaleString("en-US")
}

export function formatRate(tokS: number | undefined, digits = 1): string {
  return tokS === undefined ? "—" : tokS.toFixed(digits)
}

export function formatSeconds(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return `${minutes}m${String(seconds).padStart(2, "0")}s`
  }
  if (ms >= 10_000) return (ms / 1000).toFixed(0) + "s"
  return (ms / 1000).toFixed(1) + "s"
}

/**
 * Fold one step-finish event into its reply. Each step-finish carries the
 * usage of one LLM call, so input/cache/cost must SUM across a reply's
 * steps; a duplicate finish for an already-finished step is ignored.
 */
export function applyStepFinish(reply: ReplyMetrics, step: StepMetrics, tokens: any, cost: any, time: number): void {
  if (step.genTokens !== undefined) return
  tokens = tokens ?? {}
  step.genTokens = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0)
  step.finishedAt = time
  reply.inputTokens += Number(tokens.input) || 0
  reply.cacheReadTokens += Number(tokens.cache?.read) || 0
  reply.cost += Number(cost) || 0
}

export function hudWaitingText(elapsedMs: number): string {
  return `⏳ ${formatSeconds(elapsedMs)} waiting for first token`
}

export function hudLiveText(estTokS: number | undefined, elapsedMs: number | undefined): string {
  const elapsed = elapsedMs === undefined ? "" : ` · ${formatSeconds(elapsedMs)}`
  return `⚡ ~${formatRate(estTokS)} tok/s${elapsed}`
}

export function hudCompletedText(s: ReplySummary): string {
  const parts = [`⚡ ${formatRate(s.tokS)} tok/s`, `ttft ${formatSeconds(s.ttftMs)}`]
  if (s.totalMs !== undefined) parts.push(`total ${formatSeconds(s.totalMs)}`)
  parts.push(`↑${formatTokens(s.inputTokens)} ↓${formatTokens(s.genTokens)}`)
  return parts.join(" · ")
}

/**
 * Two detail lines for a /toks row: timings, then token flows + cost. The
 * dialog truncates each details line at ~51 cols (truncateMiddle), so the
 * split keeps every requested metric visible instead of losing the tail.
 */
export function dialogRowDetails(s: ReplySummary): string[] {
  const timings = [`ttft ${formatSeconds(s.ttftMs)}`]
  if (s.totalMs !== undefined) timings.push(`total ${formatSeconds(s.totalMs)}`)
  timings.push(`gen ${formatSeconds(s.genMs)}`)
  if (s.e2eTokS !== undefined) timings.push(`e2e ${formatRate(s.e2eTokS)} tok/s`)
  const inTok = `↑in ${formatTokens(s.inputTokens)}`
  const tokens = [
    s.cacheReadTokens > 0 ? `${inTok} (cache ${formatTokens(s.cacheReadTokens)})` : inTok,
    `↓out ${formatTokens(s.genTokens)}`,
  ]
  if (s.cost > 0) tokens.push(`$${s.cost.toFixed(4)}`)
  return [timings.join(" · "), tokens.join(" · ")]
}

export type SessionAggregate = {
  tasks: number
  inTok: number
  outTok: number
  genMs: number
  totalMs: number
  tokS?: number
}

/** contiguous assistant messages with the same taskSeq form one task */
export function groupTasks(replies: ReplyMetrics[]): ReplyMetrics[][] {
  const groups: ReplyMetrics[][] = []
  let prev: number | undefined = undefined
  for (const r of replies) {
    if (groups.length === 0 || r.taskSeq === undefined || r.taskSeq !== prev) {
      groups.push([r])
    } else {
      groups[groups.length - 1].push(r)
    }
    prev = r.taskSeq
  }
  return groups
}

/**
 * One summary for a whole task (one user send → final completion). In
 * opencode v1.19.6 a tool-using task spans several assistant messages
 * (one per LLM round); tokens, costs and steps sum across rounds while
 * ttft spans send → the task's first streamed token and total spans
 * send → the task's last completion.
 */
export function summarizeTask(replies: ReplyMetrics[]): ReplySummary | undefined {
  if (replies.length === 0) return undefined
  const sentAt = replies[0].sentAt ?? replies[0].createdAt
  let completedAt: number | undefined = undefined
  let cost = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let model = ""
  let agent = ""
  for (const r of replies) {
    if (r.completedAt !== undefined && (completedAt === undefined || r.completedAt > completedAt)) {
      completedAt = r.completedAt
    }
    cost += r.cost
    inputTokens += r.inputTokens
    cacheReadTokens += r.cacheReadTokens
    if (r.model) model = r.model
    if (r.agent) agent = r.agent
  }
  const finished = replies.flatMap((r) => r.steps).filter((s) => s.genTokens !== undefined)
  const genTokens = finished.reduce((acc, s) => acc + (s.genTokens ?? 0), 0)
  const genMs = finished.reduce((acc, s) => {
    const first = s.firstTokenAt
    const last = s.lastTokenAt
    if (first === undefined || last === undefined || last <= first) return acc
    return acc + (last - first)
  }, 0)
  let firstTokenAt: number | undefined = undefined
  for (const s of finished) {
    if (s.firstTokenAt !== undefined && (firstTokenAt === undefined || s.firstTokenAt < firstTokenAt)) {
      firstTokenAt = s.firstTokenAt
    }
  }
  const ttftMs = firstTokenAt !== undefined ? Math.max(0, firstTokenAt - sentAt) : 0
  const totalMs = completedAt !== undefined && sentAt > 0 ? Math.max(0, completedAt - sentAt) : undefined
  return {
    messageID: replies[0].messageID,
    model,
    agent,
    createdAt: replies[0].createdAt,
    completedAt,
    cost,
    inputTokens,
    cacheReadTokens,
    steps: finished.length,
    genTokens,
    genMs,
    ttftMs,
    totalMs,
    tokS: tokensPerSecond(genTokens, genMs),
    e2eTokS: totalMs !== undefined ? tokensPerSecond(genTokens, totalMs) : undefined,
  }
}

export function aggregateTasks(replies: ReplyMetrics[]): SessionAggregate {
  const summaries = groupTasks(replies)
    .filter((g) => g.some((r) => r.completedAt !== undefined))
    .map((g) => summarizeTask(g))
    .filter((s): s is ReplySummary => s !== undefined)
  const outTok = summaries.reduce((acc, s) => acc + s.genTokens, 0)
  const genMs = summaries.reduce((acc, s) => acc + s.genMs, 0)
  return {
    tasks: summaries.length,
    inTok: summaries.reduce((acc, s) => acc + s.inputTokens, 0),
    outTok,
    genMs,
    totalMs: summaries.reduce((acc, s) => acc + (s.totalMs ?? 0), 0),
    tokS: tokensPerSecond(outTok, genMs),
  }
}

export function dialogTotalsText(a: SessionAggregate): string {
  return `Σ ${a.tasks} tasks · ↑${formatTokens(a.inTok)} ↓${formatTokens(a.outTok)} · ${formatSeconds(a.totalMs)} · ${formatRate(a.tokS)} tok/s`
}

/** env-gated event tap (TOKS_DEBUG=/path/to/log): diagnostics must never break the TUI */
export function makeDebugLog(path: string | undefined): (line: string) => void {
  if (!path) return () => {}
  return (line: string) => {
    try {
      appendFileSync(path, line + "\n")
    } catch {
      // unwritable debug path: drop the line, keep the UI alive
    }
  }
}

/** hh:mm — dialog row titles clip past ~52 cols, so seconds don't fit */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Speed thresholds for HUD coloring. Measured against real models:
 * flash-class stream 80-200 tok/s, frontier models 20-60, heavily
 * reasoning-bound turns below that.
 */
export const FAST_TOKS = 60
export const SLOW_TOKS = 20

export type SpeedBand = "fast" | "medium" | "slow"

export function speedBand(tokS: number | undefined): SpeedBand | undefined {
  if (tokS === undefined) return undefined
  if (tokS >= FAST_TOKS) return "fast"
  if (tokS >= SLOW_TOKS) return "medium"
  return "slow"
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

type SessionState = {
  replies: ReplyMetrics[] // in-flight + finalized, keyed by assistant message id
  order: string[] // message ids in arrival order (for caps)
  lastSummary?: ReplySummary
  liveChars: number
  liveStartAt?: number
  busy: boolean
  busySince?: number // wall clock when the current turn went busy (live elapsed anchor)
  pendingSentAt?: number // user-message creation time awaiting its assistant reply
  turnSawToken: boolean // suppresses the waiting HUD between multi-step turns
  taskSeq: number // id of the task currently receiving assistant messages
  lastConsumedSentAt?: number // freshness bound: re-delivered user events are continuations, not new tasks
}

const MAX_REPLIES_PER_SESSION = 200
const MAX_SESSIONS = 50

const tui: TuiPlugin = async (api, _options, _meta) => {
  const solid = (await import("@opentui/solid")) as any
  const { createSignal, onCleanup } = await import("solid-js")

  const debugLog = makeDebugLog(process.env.TOKS_DEBUG)
  const sessions = new Map<string, SessionState>()
  const [version, bump] = createSignal(0) // coarser signal: HUD re-reads on change
  const [lastActive, setLastActive] = createSignal<string | undefined>(undefined)

  const session = (sessionID: string): SessionState => {
    let s = sessions.get(sessionID)
    if (!s) {
      s = { replies: [], order: [], liveChars: 0, busy: false, turnSawToken: false, taskSeq: 0 }
      sessions.set(sessionID, s)
      if (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
    }
    return s
  }

  const ensureReply = (
    s: SessionState,
    messageID: string,
    createdAt: number,
    model: string,
    agent: string,
    sentAt?: number,
  ): ReplyMetrics => {
    let reply = s.replies.find((r) => r.messageID === messageID)
    if (!reply) {
      // a sentAt strictly newer than the last consumed one starts a new task;
      // the user-message event re-delivers within a turn, so equal timestamps
      // mean a continuation round (tool calls), not a fresh send
      const fresh = sentAt !== undefined && sentAt > (s.lastConsumedSentAt ?? -Infinity)
      let taskSeq = s.taskSeq
      if (fresh) {
        s.taskSeq += 1
        taskSeq = s.taskSeq
        s.lastConsumedSentAt = sentAt
      } else if (sentAt !== undefined) {
        const prev = [...s.replies].reverse().find((r) => r.taskSeq === s.taskSeq)
        sentAt = prev?.sentAt
      }
      reply = {
        messageID,
        model,
        agent,
        createdAt,
        sentAt,
        taskSeq,
        cost: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        steps: [],
      }
      s.replies.push(reply)
      s.order.push(messageID)
      if (s.replies.length > MAX_REPLIES_PER_SESSION) {
        const drop = s.order.shift()
        if (drop) s.replies = s.replies.filter((r) => r.messageID !== drop)
      }
    } else {
      // the step-start part often arrives before message.updated fills these in
      if (!reply.model && model) reply.model = model
      if (!reply.agent && agent) reply.agent = agent
      if (reply.sentAt === undefined && sentAt !== undefined) reply.sentAt = sentAt
    }
    return reply
  }

  const ensureStep = (reply: ReplyMetrics): StepMetrics => {
    let step = reply.steps[reply.steps.length - 1]
    if (!step || step.genTokens !== undefined) {
      step = { stepStartAt: Date.now(), chars: 0 }
      reply.steps.push(step)
    }
    return step
  }

  // -- event handlers -------------------------------------------------------

  const onPartUpdated = (sessionID: string, part: any, time: number) => {
    if (!part || typeof part.messageID !== "string") return
    const s = session(sessionID)
    s.liveStartAt ??= time
    switch (part.type) {
      case "step-start": {
        const reply = ensureReply(s, part.messageID, time, "", "", s.pendingSentAt)
        s.pendingSentAt = undefined
        reply.steps.push({ stepStartAt: time, chars: 0 })
        s.liveChars = 0
        s.liveStartAt = time
        debugLog(`step-start msg=${part.messageID} t=${time}`)
        break
      }
      case "step-finish": {
        const reply = s.replies.find((r) => r.messageID === part.messageID)
        const step = reply?.steps[reply.steps.length - 1]
        if (!reply || !step) break
        applyStepFinish(reply, step, part.tokens, part.cost, time)
        debugLog(`step-finish msg=${part.messageID} t=${time} tokens=${JSON.stringify(part.tokens)}`)
        s.liveChars = 0
        break
      }
      case "text":
      case "reasoning": {
        const reply = s.replies.find((r) => r.messageID === part.messageID)
        if (!reply) break
        const step = ensureStep(reply)
        const start = part.time?.start
        const end = part.time?.end
        if (step.firstTokenAt === undefined) {
          step.firstTokenAt = typeof start === "number" ? start : time
          debugLog(`first-token msg=${part.messageID} t=${step.firstTokenAt}`)
        }
        if (typeof end === "number" && end >= (step.lastTokenAt ?? 0)) step.lastTokenAt = end
        else if (step.lastTokenAt === undefined) step.lastTokenAt = time
        const text = typeof part.text === "string" ? part.text : typeof part.reason === "string" ? part.reason : ""
        if (text.length > step.chars) {
          const delta = text.length - step.chars
          step.chars = text.length
          s.liveChars += delta
          s.turnSawToken = true
        }
        if (s.liveStartAt === undefined || (typeof start === "number" && start < s.liveStartAt)) {
          s.liveStartAt = typeof start === "number" ? start : time
        }
        break
      }
      default:
        // tool parts excluded from the generation window: their part updates also
        // fire at tool-execution completion, which would inflate the window; tool
        // tokens are still counted via step-finish.
        break
    }
    bump((v) => v + 1)
  }

  const onMessageUpdated = (sessionID: string, info: any) => {
    if (!info || typeof info.id !== "string") return
    const s = session(sessionID)
    const created = Number(info.time?.created) || Date.now()
    if (info.role === "user") {
      s.pendingSentAt = created
      debugLog(`user msg=${info.id} t=${created}`)
      bump((v) => v + 1)
      return
    }
    if (info.role !== "assistant") return
    const reply = ensureReply(s, info.id, created, String(info.modelID ?? ""), String(info.agent ?? ""), s.pendingSentAt)
    s.pendingSentAt = undefined
    if (info.time?.completed !== undefined && reply.completedAt === undefined) {
      reply.completedAt = Number(info.time.completed)
      const task = s.replies.filter((r) => r.taskSeq === reply.taskSeq)
      s.lastSummary = summarizeTask(task) ?? summarizeReply(reply)
      s.liveChars = 0
      s.liveStartAt = undefined
      debugLog(`assistant-complete msg=${info.id} task=${reply.taskSeq} created=${created} completed=${reply.completedAt}`)
    }
    bump((v) => v + 1)
  }

  const onSessionStatus = (sessionID: string, status: any) => {
    const s = session(sessionID)
    s.busy = status?.type === "busy"
    if (s.busy) {
      s.busySince = Date.now()
      s.turnSawToken = false
    } else {
      s.busySince = undefined
      s.liveChars = 0
      s.liveStartAt = undefined
      // drop unfinished steps (aborted replies)
      for (const reply of s.replies) {
        if (reply.completedAt === undefined) {
          reply.steps = reply.steps.filter((step) => step.genTokens !== undefined)
        }
      }
    }
    debugLog(`status session=${sessionID} type=${status?.type}`)
    bump((v) => v + 1)
  }

  const unsubscribers: Array<() => void> = []
  const on = (type: string, handler: (event: any) => void) => {
    try {
      unsubscribers.push((api.event as any).on(type, handler))
    } catch {
      // event type unavailable in this build — skip silently
    }
  }

  // the HUD shows wall-clock elapsed time, but re-renders were only driven by
  // server events — between them (TTFT wait, SSE batching, tool execution)
  // the timer froze; tick the mounted HUD imperatively instead
  const hudUpdaters: Array<() => void> = []
  const hudTicker = setInterval(() => {
    for (const update of hudUpdaters) update()
  }, 100)
  unsubscribers.push(() => clearInterval(hudTicker))

  on("message.part.updated", (event: any) => {
    const p = event?.properties ?? {}
    if (typeof p.sessionID === "string") setLastActive(p.sessionID)
    onPartUpdated(p.sessionID, p.part, Number(p.time) || Date.now())
  })
  on("message.updated", (event: any) => {
    const p = event?.properties ?? {}
    if (typeof p.sessionID === "string") setLastActive(p.sessionID)
    onMessageUpdated(p.sessionID, p.info)
  })
  on("session.status", (event: any) => {
    const p = event?.properties ?? {}
    onSessionStatus(p.sessionID, p.status)
  })

  // -- HUD ------------------------------------------------------------------

  const hud = (sessionID?: string): { text: string; live: boolean; tokS?: number } | undefined => {
    version()
    const id = sessionID ?? lastActive()
    if (!id) return undefined
    const s = sessions.get(id)
    if (!s) return undefined
    if (s.busy) {
      const elapsed = s.busySince !== undefined ? Math.max(0, Date.now() - s.busySince) : undefined
      if (s.liveChars > 0 && s.liveStartAt !== undefined) {
        const est = estimateTokensPerSecond(s.liveChars, Date.now() - s.liveStartAt)
        return { text: hudLiveText(est, elapsed), live: true }
      }
      // between steps (tool execution) the turn already saw tokens — the
      // previous reply's HUD stays up instead of a false "waiting" state
      if (elapsed !== undefined && !s.turnSawToken) {
        return { text: hudWaitingText(elapsed), live: true }
      }
    }
    const last = s.lastSummary
    if (last?.tokS !== undefined || last?.totalMs !== undefined) {
      return { text: hudCompletedText(last), live: false, tokS: last.tokS }
    }
    return undefined
  }

  const theme = () => (api.theme as any).current

  const hudColor = (st: { live: boolean; tokS?: number } | undefined) => {
    if (!st) return theme().info
    // live estimates stay a single neutral color: the first seconds of a
    // stream would otherwise flicker red->green while the estimate converges
    if (st.live) return theme().info
    if (speedBand(st.tokS) === "fast") return theme().success
    if (speedBand(st.tokS) === "medium") return theme().warning
    return theme().error
  }

  const renderHud = () => {
    // dedicated full-width line at the app bottom: sharing the prompt's
    // agent/model row squeezed that row on narrow terminals
    const row = solid.createElement("box")
    solid.setProp(row, "width", "100%")
    solid.setProp(row, "flexDirection", "row")
    solid.setProp(row, "justifyContent", "flex-end")
    const text = solid.createElement("text")
    solid.setProp(text, "flexShrink", 0)
    solid.insert(row, text)
    // the reconciler's TextNode patch path (signal-driven children) never
    // reaches the screen for plugin-created nodes, while the content/fg/
    // visible setters stage into the buffer Core flushes before every frame
    // and request a frame themselves — so all updates go through those
    // setters imperatively, driven by the ticker and event handlers
    let lastLogged: string | undefined
    const updateHud = () => {
      const st = hud()
      const described = st?.text ?? "none"
      if (described !== lastLogged) {
        lastLogged = described
        debugLog(`hud "${described}"`)
      }
      solid.setProp(text, "visible", st !== undefined)
      if (!st) return
      solid.setProp(text, "content", st.text)
      solid.setProp(text, "fg", hudColor(st))
    }
    updateHud()
    hudUpdaters.push(updateHud)
    // a slot remount renders a fresh contribution and leaves this updater
    // pointing at a disposed element — detach it with the contribution's owner
    onCleanup(() => {
      const i = hudUpdaters.indexOf(updateHud)
      if (i !== -1) hudUpdaters.splice(i, 1)
    })
    return row
  }

  try {
    ;(api.slots as any).register({
      id: "toks",
      order: 950,
      slots: {
        app_bottom: () => renderHud(),
      },
    })
  } catch {
    // slots API unavailable — plugin degrades to the /toks dialog only
  }

  // -- /toks dialog ---------------------------------------------------------

  const openDialog = (dialogStack: any) => {
    version()
    const id = lastActive()
    const s = id ? sessions.get(id) : undefined
    const stack = dialogStack ?? (api.ui as any).dialog
    const rows: Array<Record<string, unknown>> = []
    if (s) {
      const totals = aggregateTasks(s.replies)
      if (totals.tasks > 0) {
        rows.push({
          title: dialogTotalsText(totals),
          value: "totals",
          details: [id],
          onSelect: () => stack.clear(),
        })
      }
      const finalized = groupTasks(s.replies)
        .filter((g) => g.some((r) => r.completedAt !== undefined))
        .map((g) => summarizeTask(g))
        .filter((summary): summary is ReplySummary => summary !== undefined)
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      for (const r of finalized.slice(0, 100)) {
        rows.push({
          title: `${formatClock(r.createdAt)} · ${r.model || "?"} · ${r.steps} step${r.steps === 1 ? "" : "s"} · ${formatRate(r.tokS)} tok/s`,
          value: r.messageID,
          // DialogSelect clips inline descriptions past ~55 cols; details
          // lines render under the row instead
          details: dialogRowDetails(r),
          onSelect: () => stack.clear(),
        })
      }
    }
    stack.replace(() =>
      (api.ui as any).DialogSelect({
        title: rows.length > 0 ? "toks — conversation speed" : "toks — no completed replies yet in this TUI run",
        options:
          rows.length > 0
            ? rows
            : [{ title: "Send a message first; measured tok/s will appear here.", value: "empty", onSelect: () => stack.clear() }],
        onSelect: (option: any) => option?.onSelect?.(),
      }),
    )
  }

  try {
    const command = (api as any).command
    if (command?.register) {
      unsubscribers.push(
        command.register(() => [
          {
            title: "Conversation speed (tok/s)",
            value: "toks.dialog",
            description: "Measured tok/s for every reply in this session",
            category: "Session",
            slash: { name: "toks" },
            onSelect: (dialog?: any) => openDialog(dialog),
          },
        ]) as () => void,
      )
    }
  } catch {
    // command API unavailable in this build
  }

  ;(api.lifecycle as any).onDispose(async () => {
    for (const unsubscribe of unsubscribers) {
      try {
        unsubscribe()
      } catch {
        // best-effort cleanup
      }
    }
  })
}

export default { id: "toks", tui }

