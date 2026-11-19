# toks

An [opencode](https://opencode.ai) **v1** TUI plugin that shows **tok/s (tokens per second) for every conversation**, measured from opencode's own token events — no estimates in the final numbers.

```
┃ Ask anything…                                                    ⚡ 41.3 tok/s ┃
```

- While the model streams, a live estimate appears beside the prompt: `⚡ ~48.5 tok/s`
- When a reply completes, it settles to the measured rate for that reply — **colored by speed**

| Rate | Color | Meaning |
|---|---|---|
| ≥ 60 tok/s | green | flash-class streaming |
| 20 – 60 tok/s | yellow | typical frontier model |
| < 20 tok/s | red | slow / heavily reasoning-bound |

(Live estimates stay a single neutral color while they converge.)

`/toks` opens a dialog with per-reply history and session totals:

```
 toks — conversation speed
 Σ 2 replies · 116 tok generated · 1.2s · 97.3 tok/s avg
 01:33:26 · deepseek-v4.1-flash · 1 step · out 10 tok · 161.3 tok/s
   gen 0.2s · in 56.7k (cache 12.4k) · e2e 21.3 tok/s · ttft 1.2s
 01:32:49 · deepseek-v4.1-flash · 1 step · out 106 tok · 96.4 tok/s
   gen 1.1s · in 12.3k (cache 0) · e2e 4.9 tok/s · ttft 1.4s
```

## How it measures

All numbers come from opencode's v1 event stream (`message.part.updated`, `message.updated`, `session.status`):

- **Generated tokens** = `step-finish` `tokens.output + tokens.reasoning`. opencode's `tokens.output` excludes reasoning, so the two must be summed.
- **Generation window** = first streaming part activity → last streaming part activity within a step. This excludes time-to-first-token and tool-execution gaps — the number people mean by "tok/s". Windows under 100 ms are discarded as SSE-batching artifacts rather than reported as absurd rates.
- A reply (assistant message) aggregates all of its steps; tool-call JSON tokens are counted via `step-finish`.
- `e2e` is the end-to-end rate over the whole reply (`time.created → time.completed`) for contrast; `ttft` is time-to-first-token of the first step.
- opencode's assistant `tokens` field only reflects the *last* step's usage — this plugin always sums across steps instead.

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

Data lives in memory for the current TUI run only; nothing is written to disk, and nothing leaves your machine.

## Uninstall

Remove the file and its `tui.json` entry.

## Dev

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests for the tok/s math, bands, formatters
```

### opencode v1.19.x plugin quirks this works around

- A TUI plugin module must default-export `{ id, tui }`. The stale `@opencode-ai/plugin` type says `id?: never`, but the TUI host silently drops slot registrations whose argument lacks a string `id` — the runtime wins.
- Directory scanning only picks up `*.{ts,js}` — `.tsx` files are silently skipped. So this plugin is plain `.ts` and builds its UI through the `@opentui/solid` reconciler helpers (`createElement`, `setProp`, `insert`), imported dynamically inside `tui()`.
- `api.event` in the TUI delivers the full v1 event lifecycle with exact timestamps; the legacy `api.command.register` (deprecated but functional in v1) provides the `/toks` slash command, guarded with `?.` so newer builds without it degrade gracefully.

## License

MIT
