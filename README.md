# toks

An [opencode](https://opencode.ai) **v1** TUI plugin that shows **tok/s, task durations and token counts for every conversation**, measured from opencode's own events — no estimates in the final numbers.

```
┃ Ask anything… ┃
                                     ⏳ 1.4s waiting for first token
                                     ⚡ ~48.5 tok/s · 8.2s
                                     ⚡ 41.3 tok/s · ttft 0.3s · total 6.2s · ↑12.3k ↓8.5k
```

The HUD renders on its own full-width line at the very bottom of the screen (the `app_bottom` slot) — right-aligned, colored by speed, never squeezing the prompt's agent/model row. The waiting timer and live estimate tick continuously (~10 Hz from a wall clock, not just when server events arrive), so the numbers stay live through TTFT waits, SSE batching gaps and tool execution.

- Before the first token: a waiting timer counts up from the send
- While the model streams: a live estimate plus elapsed task time
- When the task completes: the measured rate for that task — **colored by speed** — alongside `ttft` (send → first token), `total` (send → completion) and the task's input/output tokens

| Rate | Color | Meaning |
|---|---|---|
| ≥ 60 tok/s | green | flash-class streaming |
| 20 – 60 tok/s | yellow | typical frontier model |
| < 20 tok/s | red | slow / heavily reasoning-bound |

(Live estimates stay a single neutral color while they converge.)

`/toks` opens a dialog with per-task history and session totals:

```
 toks — conversation speed
 Σ 1 tasks · ↑56.9k ↓135 · 6.0s · 206.7 tok/s
 07:57 · deepseek-v4.1-flash · 2 steps · 206.7 tok/s
   ttft 3.6s · total 6.0s · gen 0.7s · e2e 22.5 tok/s
   ↑in 56.9k (cache 56.7k) · ↓out 135
 07:54 · deepseek-v4.1-flash · 1 step · 96.4 tok/s
   ttft 1.4s · total 2.1s · gen 1.1s · e2e 4.9 tok/s
   ↑in 12.3k · ↓out 106 · $0.0041
```

A **task** is one user send. opencode v1.19 runs each LLM round (tool call, then the follow-up answer) as a separate assistant message — toks groups consecutive rounds into the task you actually perceive, sums their tokens and steps, and reports `ttft` from the send to the first streamed token of the task, `total` from the send to the final completion.

## How it measures

All numbers come from opencode's v1 event stream (`message.part.updated`, `message.updated`, `session.status`):

- **Output tokens** (`↓out`) = `step-finish` `tokens.output + tokens.reasoning`, summed across every step of the task. opencode's `tokens.output` excludes reasoning, so the two must be summed.
- **Input tokens** (`↑in`) = `step-finish` `tokens.input`, summed across every LLM round. The assistant message's own `tokens` field only reflects the *last* round — this plugin never trusts it. Prompt-cache reads are shown separately as `cache`.
- **ttft** = user send → first streamed token, anchored on the user message's creation time (falling back to the assistant message's). This is the wait you feel before output starts.
- **total** = user send → final completion, including TTFT, tool execution and gaps between rounds.
- **Generation window** (`gen`) = first streaming part activity → last streaming part activity within a step. This excludes TTFT and tool-execution gaps — the number people mean by "tok/s". Windows under 100 ms are discarded as SSE-batching artifacts rather than reported as absurd rates.
- `e2e` is the end-to-end rate over `total` for contrast; cost (`$`) is summed across rounds.

## Install

1. Copy the plugin into opencode's config plugins directory:

   ```sh
   mkdir -p ~/.config/opencode/plugins
   curl -o ~/.config/opencode/plugins/toks.ts https://raw.githubusercontent.com/ech0Ex9/opencode-plugin-toks/main/toks.ts
   ```

2. Reference it in `~/.config/opencode/tui.json` — the TUI loads its plugins from here, **not** from `opencode.json`:

   ```json
   {
     "plugin": [
       "/home/YOU/.config/opencode/plugins/toks.ts"
     ]
   }
   ```

3. Restart the opencode TUI and send a message — the HUD appears beside the prompt; `/toks` lists the history.

Data lives in memory for the current TUI run only; nothing is written to disk, and nothing leaves your machine. (Exception: set `TOKS_DEBUG=/path/to/file` in the TUI's environment and the plugin appends one line per event there — useful when poking at event shapes on a new opencode build.)

## Uninstall

Remove the file and its `tui.json` entry.

## Dev

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests for the rate/duration/token math, bands, formatters
```

### opencode v1.19.x plugin quirks this works around

- A TUI plugin module must default-export `{ id, tui }`. The stale `@opencode-ai/plugin` type says `id?: never`, but the TUI host silently drops slot registrations whose argument lacks a string `id` — the runtime wins.
- Directory scanning only picks up `*.{ts,js}` — `.tsx` files are silently skipped. So this plugin is plain `.ts` and builds its UI through the `@opentui/solid` reconciler helpers (`createElement`, `setProp`, `insert`), imported dynamically inside `tui()`.
- `api.event` in the TUI delivers the full v1 event lifecycle with exact timestamps; the legacy `api.command.register` (deprecated but functional in v1) provides the `/toks` slash command, guarded with `?.` so newer builds without it degrade gracefully.

## License

MIT
