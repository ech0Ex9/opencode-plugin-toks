/**
 * toks — tok/s display for each conversation (opencode v1 TUI plugin)
 *
 * Shows generation throughput next to the prompt:
 *   ⚡ ~12.4 tok/s   (live estimate while streaming)
 *   ⚡ 41.3 tok/s    (last reply, measured from token events)
 *
 * `/toks` opens a dialog with per-reply history:
 *   time · model · steps · out tokens · gen window · tok/s (plus input, e2e, ttft, cost)
 *
 * Measurement (all from server events, no estimates in final numbers):
 *   - generation tokens  = step-finish tokens.output + tokens.reasoning
 *     (opencode's tokens.output EXCLUDES reasoning — the two must be summed)
 *   - generation window = first streaming part activity → last streaming part
 *     activity within a step (excludes TTFT and tool-execution gaps)
 *   - a reply (assistant message) aggregates all its steps; tool-call JSON
 *     streams count as generation because step tokens include them
 *
 * Install: copy to ~/.opencode/plugins/ (or another scanned plugins dir) and add
 * the file path to the "plugin" array in ~/.config/opencode/tui.json.
 */
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
  const firstStep = finished[0]
  const ttftMs = firstStep?.firstTokenAt !== undefined ? Math.max(0, firstStep.firstTokenAt - firstStep.stepStartAt) : 0
  const e2e =
    reply.completedAt !== undefined && reply.createdAt > 0
      ? Math.max(0, reply.completedAt - reply.createdAt)
      : undefined
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
    tokS: tokensPerSecond(genTokens, genMs),
    e2eTokS: e2e !== undefined ? tokensPerSecond(genTokens, e2e) : undefined,
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
  if (ms >= 10_000) return (ms / 1000).toFixed(0) + "s"
  return (ms / 1000).toFixed(1) + "s"
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
}

const MAX_REPLIES_PER_SESSION = 200
const MAX_SESSIONS = 50

const tui: TuiPlugin = async (api, _options, _meta) => {
  const solid = (await import("@opentui/solid")) as any
  const { createSignal } = await import("solid-js")

  const sessions = new Map<string, SessionState>()
  const [version, bump] = createSignal(0) // coarser signal: HUD re-reads on change
  const [lastActive, setLastActive] = createSignal<string | undefined>(undefined)

  const session = (sessionID: string): SessionState => {
    let s = sessions.get(sessionID)
    if (!s) {
      s = { replies: [], order: [], liveChars: 0, busy: false }
      sessions.set(sessionID, s)
      if (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
    }
    return s
  }

  const ensureReply = (s: SessionState, messageID: string, createdAt: number, model: string, agent: string): ReplyMetrics => {
    let reply = s.replies.find((r) => r.messageID === messageID)
    if (!reply) {
      reply = {
        messageID,
        model,
        agent,
        createdAt,
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
        const reply = ensureReply(s, part.messageID, time, "", "")
        reply.steps.push({ stepStartAt: time, chars: 0 })
        s.liveChars = 0
        s.liveStartAt = time
        break
      }
      case "step-finish": {
        const reply = s.replies.find((r) => r.messageID === part.messageID)
        const step = reply?.steps[reply.steps.length - 1]
        if (!reply || !step || step.genTokens !== undefined) break
        const tokens = part.tokens ?? {}
        step.genTokens = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0)
        step.finishedAt = time
        reply.inputTokens = Number(tokens.input) || 0
        reply.cacheReadTokens = Number(tokens.cache?.read) || 0
        reply.cost += Number(part.cost) || 0
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
        if (step.firstTokenAt === undefined) step.firstTokenAt = typeof start === "number" ? start : time
        if (typeof end === "number" && end >= (step.lastTokenAt ?? 0)) step.lastTokenAt = end
        else if (step.lastTokenAt === undefined) step.lastTokenAt = time
        const text = typeof part.text === "string" ? part.text : typeof part.reason === "string" ? part.reason : ""
        if (text.length > step.chars) {
          const delta = text.length - step.chars
          step.chars = text.length
          s.liveChars += delta
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
    if (!info || info.role !== "assistant" || typeof info.id !== "string") return
    const s = session(sessionID)
    const reply = ensureReply(s, info.id, Number(info.time?.created) || Date.now(), String(info.modelID ?? ""), String(info.agent ?? ""))
    if (info.time?.completed !== undefined && reply.completedAt === undefined) {
      reply.completedAt = Number(info.time.completed)
      s.lastSummary = summarizeReply(reply)
      s.liveChars = 0
      s.liveStartAt = undefined
    }
    bump((v) => v + 1)
  }

  const onSessionStatus = (sessionID: string, status: any) => {
    const s = session(sessionID)
    s.busy = status?.type === "busy"
    if (!s.busy) {
      s.liveChars = 0
      s.liveStartAt = undefined
      // drop unfinished steps (aborted replies)
      for (const reply of s.replies) {
        if (reply.completedAt === undefined) {
          reply.steps = reply.steps.filter((step) => step.genTokens !== undefined)
        }
      }
    }
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

  const hud = (sessionID: string | undefined): { text: string; live: boolean; tokS?: number } | undefined => {
    version()
    const id = sessionID ?? lastActive()
    if (!id) return undefined
    const s = sessions.get(id)
    if (!s) return undefined
    if (s.busy && s.liveChars > 0 && s.liveStartAt !== undefined) {
      const est = estimateTokensPerSecond(s.liveChars, Date.now() - s.liveStartAt)
      if (est !== undefined) return { text: `⚡ ~${formatRate(est)} tok/s`, live: true }
    }
    const last = s.lastSummary
    if (last?.tokS !== undefined) return { text: `⚡ ${formatRate(last.tokS)} tok/s`, live: false, tokS: last.tokS }
    return undefined
  }

  const theme = () => (api.theme as any).current

  const renderHud = (sessionID: string | undefined) => {
    const state = hud(sessionID)
    if (!state) return null
    // live estimates stay a single neutral color: the first seconds of a stream
    // would otherwise flicker red->green while the estimate converges
    const fg = state.live
      ? theme().info
      : speedBand(state.tokS) === "fast"
        ? theme().success
        : speedBand(state.tokS) === "medium"
          ? theme().warning
          : theme().error
    const text = solid.createElement("text")
    solid.setProp(text, "flexShrink", 0)
    solid.insert(text, state.text)
    solid.setProp(text, "fg", fg)
    return text
  }

  try {
    ;(api.slots as any).register({
      id: "toks",
      order: 950,
      slots: {
        home_prompt_right: () => renderHud(undefined),
        session_prompt_right: (_ctx: unknown, props: any) =>
          renderHud(typeof props?.session_id === "string" ? props.session_id : undefined),
      },
    })
  } catch {
    // slots API unavailable — plugin degrades to the /toks dialog only
  }

  // -- /toks dialog ---------------------------------------------------------

  const sessionTotals = (s: SessionState) => {
    const summaries = s.replies.filter((r) => r.completedAt !== undefined).map((r) => summarizeReply(r))
    const genTokens = summaries.reduce((acc, r) => acc + r.genTokens, 0)
    const genMs = summaries.reduce((acc, r) => acc + r.genMs, 0)
    return {
      replies: summaries.length,
      genTokens,
      genMs,
      tokS: tokensPerSecond(genTokens, genMs),
    }
  }

  const openDialog = (dialogStack: any) => {
    version()
    const id = lastActive()
    const s = id ? sessions.get(id) : undefined
    const stack = dialogStack ?? (api.ui as any).dialog
    const rows: Array<Record<string, unknown>> = []
    if (s) {
      const totals = sessionTotals(s)
      if (totals.replies > 0) {
        rows.push({
          title: `Σ ${totals.replies} replies · ${formatTokens(totals.genTokens)} tok generated · ${formatSeconds(totals.genMs)} · ${formatRate(totals.tokS)} tok/s avg`,
          value: "totals",
          description: id,
          onSelect: () => stack.clear(),
        })
      }
      const finalized = s.replies
        .filter((r) => r.completedAt !== undefined)
        .map((r) => summarizeReply(r))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      for (const r of finalized.slice(0, 100)) {
        rows.push({
          title: `${formatClock(r.createdAt)} · ${r.model || "?"} · ${r.steps} step${r.steps === 1 ? "" : "s"} · out ${formatTokens(r.genTokens)} tok · ${formatRate(r.tokS)} tok/s`,
          value: r.messageID,
          description:
            `gen ${formatSeconds(r.genMs)} · in ${formatTokens(r.inputTokens)} (cache ${formatTokens(r.cacheReadTokens)}) · e2e ${formatRate(r.e2eTokS)} tok/s · ttft ${formatSeconds(r.ttftMs)}${r.cost > 0 ? ` · $${r.cost.toFixed(4)}` : ""}`,
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

