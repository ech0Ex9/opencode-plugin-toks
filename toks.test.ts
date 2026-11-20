import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { test } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aggregateTasks,
  applyStepFinish,
  dialogRowDetails,
  dialogTotalsText,
  estimateTokensPerSecond,
  formatClock,
  formatRate,
  formatSeconds,
  formatTokens,
  groupTasks,
  hudCompletedText,
  hudLiveText,
  hudWaitingText,
  makeDebugLog,
  speedBand,
  summarizeReply,
  summarizeTask,
  tokensPerSecond,
  type ReplyMetrics,
  type ReplySummary,
} from "./toks.ts"

const reply = (over: Partial<ReplyMetrics> = {}): ReplyMetrics => ({
  messageID: "msg_1",
  model: "glm-5.3",
  agent: "build",
  createdAt: 1_000,
  cost: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  steps: [],
  ...over,
})

test("tokensPerSecond: 100 tokens in 2s = 50 tok/s", () => {
  assert.equal(tokensPerSecond(100, 2000), 50)
})

test("tokensPerSecond: zero tokens is undefined (avoid Infinity)", () => {
  assert.equal(tokensPerSecond(0, 2000), undefined)
})

test("tokensPerSecond: zero window is undefined (avoid division by zero)", () => {
  assert.equal(tokensPerSecond(10, 0), undefined)
})

test("tokensPerSecond: sub-100ms windows are batching artifacts, not rates", () => {
  assert.equal(tokensPerSecond(10, 99), undefined)
  assert.equal(tokensPerSecond(10, 100), 100)
})

test("estimateTokensPerSecond: 400 chars in 2s estimates 50 tok/s at 4 chars/token", () => {
  assert.equal(estimateTokensPerSecond(400, 2000), 50)
})

test("summarizeReply: single step gen window excludes TTFT, e2e includes it", () => {
  const summary = summarizeReply(
    reply({
      createdAt: 1_000,
      completedAt: 4_000,
      steps: [{ stepStartAt: 1_200, firstTokenAt: 1_500, lastTokenAt: 3_500, chars: 800, genTokens: 100 }],
    }),
  )
  assert.equal(summary.genTokens, 100)
  assert.equal(summary.genMs, 2000)
  assert.ok(Math.abs((summary.tokS ?? 0) - 50) < 0.1)
  assert.ok(Math.abs((summary.e2eTokS ?? 0) - 33.33) < 0.1)
  // ttft spans send→first token: sentAt falls back to the assistant message's
  // createdAt when no user-message event was seen (1_000), not step start (1_200)
  assert.equal(summary.ttftMs, 500)
  assert.equal(summary.totalMs, 3_000)
  assert.equal(summary.steps, 1)
})

test("summarizeReply: ttft anchors on sentAt (user send) when present", () => {
  const summary = summarizeReply(
    reply({
      sentAt: 1_000,
      createdAt: 1_100,
      completedAt: 4_200,
      steps: [{ stepStartAt: 1_200, firstTokenAt: 1_500, lastTokenAt: 3_500, chars: 800, genTokens: 100 }],
    }),
  )
  assert.equal(summary.ttftMs, 500)
  assert.equal(summary.totalMs, 3_200)
})

test("summarizeReply: totalMs stays undefined until the reply completes", () => {
  const summary = summarizeReply(
    reply({
      sentAt: 1_000,
      steps: [{ stepStartAt: 1_200, firstTokenAt: 1_400, lastTokenAt: 2_000, chars: 100, genTokens: 10 }],
    }),
  )
  assert.equal(summary.totalMs, undefined)
  assert.equal(summary.e2eTokS, undefined)
})

test("applyStepFinish: sums input/cache/cost across steps, ignores duplicate finishes", () => {
  const r = reply({
    sentAt: 0,
    steps: [
      { stepStartAt: 1_000, chars: 0 },
      { stepStartAt: 4_000, chars: 0 },
    ],
  })
  applyStepFinish(r, r.steps[0], { input: 100, output: 40, reasoning: 5, cache: { read: 10 } }, 0.01, 2_000)
  applyStepFinish(r, r.steps[1], { input: 50, output: 60, cache: { read: 5 } }, 0.02, 6_000)
  applyStepFinish(r, r.steps[1], { input: 999, output: 999 }, 9, 6_500)
  assert.equal(r.steps[0].genTokens, 45)
  assert.equal(r.steps[1].genTokens, 60)
  assert.equal(r.steps[1].finishedAt, 6_000)
  assert.equal(r.inputTokens, 150)
  assert.equal(r.cacheReadTokens, 15)
  assert.equal(r.cost, 0.03)
})

test("summarizeReply: multi step sums tokens and generation windows", () => {
  const summary = summarizeReply(
    reply({
      steps: [
        { stepStartAt: 1_000, firstTokenAt: 1_100, lastTokenAt: 2_100, chars: 400, genTokens: 50 },
        { stepStartAt: 5_000, firstTokenAt: 5_100, lastTokenAt: 6_100, chars: 400, genTokens: 50 },
      ],
    }),
  )
  assert.equal(summary.genTokens, 100)
  assert.equal(summary.genMs, 2000)
  assert.equal(summary.tokS, 50)
  assert.equal(summary.steps, 2)
})

test("summarizeReply: steps without tokens (aborted/tool-only) do not count", () => {
  const summary = summarizeReply(
    reply({
      steps: [
        { stepStartAt: 1_000, firstTokenAt: 1_100, lastTokenAt: 2_100, chars: 0 },
        { stepStartAt: 3_000, firstTokenAt: 3_100, lastTokenAt: 3_600, chars: 120, genTokens: 30 },
      ],
    }),
  )
  assert.equal(summary.genTokens, 30)
  assert.equal(summary.genMs, 500)
  assert.equal(summary.tokS, 60)
  assert.equal(summary.steps, 1)
})

test("summarizeReply: caller pre-sums output+reasoning into genTokens", () => {
  const summary = summarizeReply(
    reply({ steps: [{ stepStartAt: 0, firstTokenAt: 1_000, lastTokenAt: 2_000, chars: 0, genTokens: 100 }] }),
  )
  assert.equal(summary.genTokens, 100)
})

test("formatTokens abbreviates large numbers, keeps small ones exact", () => {
  assert.equal(formatTokens(980), "980")
  assert.equal(formatTokens(12_400), "12.4k")
  assert.equal(formatTokens(2_500_000), "2.5M")
})

test("formatRate renders undefined as a dash", () => {
  assert.equal(formatRate(undefined), "—")
  assert.equal(formatRate(41.34), "41.3")
})

test("formatSeconds uses one decimal under 10s, none above", () => {
  assert.equal(formatSeconds(1_500), "1.5s")
  assert.equal(formatSeconds(12_000), "12s")
})

test("speedBand grades at the 60/20 thresholds with undefined passthrough", () => {
  assert.equal(speedBand(60), "fast")
  assert.equal(speedBand(159.9), "fast")
  assert.equal(speedBand(59.9), "medium")
  assert.equal(speedBand(20), "medium")
  assert.equal(speedBand(19.9), "slow")
  assert.equal(speedBand(0), "slow")
  assert.equal(speedBand(undefined), undefined)
})

test("formatSeconds renders m+ss above a minute", () => {
  assert.equal(formatSeconds(1_500), "1.5s")
  assert.equal(formatSeconds(12_000), "12s")
  assert.equal(formatSeconds(62_000), "1m02s")
  assert.equal(formatSeconds(90_000), "1m30s")
  assert.equal(formatSeconds(3_600_000), "60m00s")
})

const summaryFixture = (): ReplySummary => ({
  messageID: "msg_1",
  model: "glm-5.3",
  agent: "build",
  createdAt: 1_000,
  completedAt: 7_200,
  cost: 0.0123,
  inputTokens: 12_340,
  cacheReadTokens: 9_876,
  steps: 1,
  genTokens: 8_532,
  genMs: 2_000,
  ttftMs: 300,
  totalMs: 6_200,
  tokS: 105.9,
  e2eTokS: 47.7,
})

test("hudCompletedText: rate, ttft, total duration, in/out tokens", () => {
  assert.equal(hudCompletedText(summaryFixture()), "⚡ 105.9 tok/s · ttft 0.3s · total 6.2s · ↑12.3k ↓8,532")
})

test("hudCompletedText: drops total when incomplete, dashes unknown rate", () => {
  const s = summaryFixture()
  s.totalMs = undefined
  s.tokS = undefined
  assert.equal(hudCompletedText(s), "⚡ — tok/s · ttft 0.3s · ↑12.3k ↓8,532")
})

test("hudLiveText: live estimate plus elapsed since send", () => {
  assert.equal(hudLiveText(48.5, 8_234), "⚡ ~48.5 tok/s · 8.2s")
  assert.equal(hudLiveText(undefined, 300), "⚡ ~— tok/s · 0.3s")
})

test("hudWaitingText: elapsed toward the first token", () => {
  assert.equal(hudWaitingText(1_500), "⏳ 1.5s waiting for first token")
})

test("dialogRowDetails: timing line then token/cost line, each under the 51-col dialog detail budget", () => {
  const lines = dialogRowDetails(summaryFixture())
  assert.deepEqual(lines, [
    "ttft 0.3s · total 6.2s · gen 2.0s · e2e 47.7 tok/s",
    "↑in 12.3k (cache 9,876) · ↓out 8,532 · $0.0123",
  ])
  assert.ok(lines.every((line) => line.length <= 51), JSON.stringify(lines))
})

test("dialogRowDetails: omits zero cache, zero cost, missing e2e/total", () => {
  const s = summaryFixture()
  s.cacheReadTokens = 0
  s.cost = 0
  s.e2eTokS = undefined
  s.totalMs = undefined
  assert.deepEqual(dialogRowDetails(s), ["ttft 0.3s · gen 2.0s", "↑in 12.3k · ↓out 8,532"])
})

test("aggregateTasks: one send with tool calls = one task; fresh sends split tasks", () => {
  // mirrors real v1.19.6 events: a tool task emits two assistant messages
  // (tool round, then answer round 1ms later) with the same user send
  const task = (): ReplyMetrics[] => [
    reply({
      messageID: "a1",
      taskSeq: 1,
      sentAt: 1_000,
      createdAt: 1_100,
      completedAt: 17_500,
      inputTokens: 56_780,
      cacheReadTokens: 0,
      cost: 0.01,
      steps: [{ stepStartAt: 16_300, firstTokenAt: 16_324, lastTokenAt: 17_400, chars: 0, genTokens: 98 }],
    }),
    reply({
      messageID: "a2",
      taskSeq: 1,
      sentAt: 1_000,
      createdAt: 17_501,
      completedAt: 29_100,
      inputTokens: 56_836,
      cacheReadTokens: 40,
      cost: 0.02,
      model: "deepseek-v4.1-flash",
      steps: [{ stepStartAt: 28_800, firstTokenAt: 28_809, lastTokenAt: 28_812, chars: 0, genTokens: 11 }],
    }),
  ]
  const summaries = groupTasks([...task(), reply({ messageID: "b1", taskSeq: 2 })])
  assert.deepEqual(
    summaries.map((g) => g.map((r) => r.messageID)),
    [["a1", "a2"], ["b1"]],
  )
  const s = summarizeTask(task())
  assert.ok(s)
  assert.equal(s.ttftMs, 15_324) // send → first streamed token of the whole task
  assert.equal(s.totalMs, 28_100) // send → final completion
  assert.equal(s.steps, 2)
  assert.equal(s.genTokens, 109)
  assert.equal(s.inputTokens, 113_616)
  assert.equal(s.cacheReadTokens, 40)
  assert.equal(s.cost, 0.03)
  assert.equal(s.model, "deepseek-v4.1-flash") // last round's model wins
  assert.ok(Math.abs((s.tokS ?? 0) - 101.0) < 0.1)
  assert.ok(Math.abs((s.e2eTokS ?? 0) - 3.88) < 0.01)
})

test("summarizeTask: single-message task matches summarizeReply", () => {
  const single = reply({
    sentAt: 1_000,
    createdAt: 1_100,
    completedAt: 4_000,
    steps: [{ stepStartAt: 1_200, firstTokenAt: 1_500, lastTokenAt: 3_500, chars: 800, genTokens: 100 }],
  })
  assert.deepEqual(summarizeTask([single]), summarizeReply(single))
})

test("aggregateTasks: counts only tasks with a completed reply; sums in/out/durations", () => {
  const done = (taskSeq: number, sentAt: number, completedAt: number, input: number, out: number) =>
    reply({
      taskSeq,
      sentAt,
      createdAt: sentAt,
      completedAt,
      inputTokens: input,
      cacheReadTokens: Math.floor(input / 10),
      steps: [{ stepStartAt: sentAt + 200, firstTokenAt: sentAt + 400, lastTokenAt: completedAt - 100, chars: 0, genTokens: out }],
    })
  const agg = aggregateTasks([
    done(1, 1_000, 4_000, 1_000, 100),
    done(2, 10_000, 13_000, 500, 100),
    reply({
      taskSeq: 3,
      sentAt: 20_000,
      steps: [{ stepStartAt: 20_200, firstTokenAt: 20_400, lastTokenAt: 21_000, chars: 0, genTokens: 5 }],
    }),
  ])
  assert.equal(agg.tasks, 2)
  assert.equal(agg.inTok, 1_500)
  assert.equal(agg.outTok, 200)
  assert.equal(agg.genMs, 5_000)
  assert.equal(agg.totalMs, 6_000)
  assert.equal(agg.tokS, tokensPerSecond(200, 5_000))
  assert.equal(dialogTotalsText(agg), "Σ 2 tasks · ↑1,500 ↓200 · 6.0s · 40.0 tok/s")
})

test("dialogTotalsText fits the ~52-col dialog row budget", () => {
  const long = dialogTotalsText({
    tasks: 10,
    inTok: 1_234_567,
    outTok: 987_654,
    genMs: 125_000,
    totalMs: 3_600_000,
    tokS: 99.95,
  })
  assert.ok(long.length <= 52, `${long.length}: ${long}`)
})

test("formatClock renders hh:mm so dialog row titles fit the ~52-col budget", () => {
  const clock = formatClock(new Date("2026-11-20T07:54:36").getTime())
  assert.equal(clock, "07:54")
  assert.ok(clock.length <= 5)
})

test("makeDebugLog: appends when given a path, silent no-op otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "toks-test-"))
  try {
    const file = join(dir, "events.log")
    const log = makeDebugLog(file)
    log("hello")
    log("world")
    assert.equal(readFileSync(file, "utf8"), "hello\nworld\n")
    makeDebugLog(undefined)("nope")
    assert.equal(existsSync(join(dir, "missing.log")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
