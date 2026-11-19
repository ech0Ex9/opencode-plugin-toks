import assert from "node:assert/strict"
import { test } from "node:test"
import {
  estimateTokensPerSecond,
  formatRate,
  formatSeconds,
  formatTokens,
  speedBand,
  summarizeReply,
  tokensPerSecond,
  type ReplyMetrics,
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
  assert.equal(summary.ttftMs, 300)
  assert.equal(summary.steps, 1)
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
