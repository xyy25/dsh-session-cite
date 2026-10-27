# dsh-session-cite

Compress **another session** into a snapshot and carry it into the current conversation as a reference (mention); when you need more detail, let the agent continue reading with the read-only `session_read` tool. Useful for "bring the last debugging session into this one" or "let this session reuse the conclusion from another session" without copy-pasting transcripts.

You can also forward a hand-picked set of messages verbatim, or click the forward button at the tail of a turn to move one or several whole turns into another session.

## Features

- **`/ref` command**: run `/ref <session>` in the current session; the plugin compresses the target session into a snapshot and emits a `dsh-session:` reference (`@[title](dsh-session:...)`) into the current user message.
- **Two modes**: `send` submits the reference message directly; `draft` only fills the composer draft so you can add your own words before sending.
- **`session_read` read-only tool**: when the snapshot is not enough, the agent can read further content of the target session (chunked by a byte budget).
- **Message-level forwarding (`--list` / `--pick`)**: pick specific messages by seq; `--compact` summarizes them first.
- **Per-turn forward button**: one button at the tail of each turn, forwarding this turn (or several turns) to another session.
- **Client-side draft refill (Web)**: in `draft` mode the Web UI fills the composer automatically, so you just add a sentence and send.

## Installation

1. Add the plugin to the target profile (using `web` as an example):

   ```
   dsh plugin --profile web add link:G:\dsh-dev\plugins\dsh-session-cite
   ```

2. Merge the following entry into the **top-level array** of `~/.dsh/profiles/web/cordis.patch.yml` (the file itself is an array; append it, and do not remove existing entries):

   ```yaml
   - insert:
       - id: session-cite
         name: 'dsh-session-cite'
         config:
           mode: send
           maxReferences: 3
           guidance: ''
           readBytes: 16384
   ```

   The install step above usually merges this entry automatically; only add it by hand when no `session-cite` row exists in the profile (if the id already exists, edit its `config` instead of inserting a duplicate). The repository's `cordis.patch.yml` is the bundle default patch, and `examples/cordis.patch.yml` is an annotated installation example.

3. Restart the profile session (or let the Host reload the plugin), then run `/ref` in any session.

> The repository ships build artifacts (`lib/`, `client/`), so neither git installation nor a `link:` install needs a local build. After changing source, run `npm run build` before committing — otherwise installers keep receiving the old artifacts.

> The per-turn forward panel and the message picker rely on a read-only route registered by the plugin (`/api/dsh-session-cite/turn-messages`). Changes to the Host side therefore require a restart; reloading the page is not enough.

## `/ref` usage

```
/ref <session>
/ref --draft <session>
/ref --send <session>
```

- `<session>`: keywords used to locate the target session (title, path, short id, full id — matched by the host implementation).
- `--send`: ignores `mode` and submits the reference text as this turn's user message.
- `--draft`: ignores `mode` and only fills the composer draft (the Web UI refills automatically; other surfaces return the text as a command result for you to copy).
- Without a flag, the `mode` config decides.
- At most `maxReferences` sessions per invocation; exceeding it returns an error result and sends nothing.

On success the command result looks like:

```
@[Session title](dsh-session:eyJpZCI6InNlc3Npb24tLi4uIn0) referenced 1 session snapshot
```

## `session_read` usage

When the referenced session has more content past the snapshot, ask the agent to call the read-only tool:

- Tool name: `session_read`
- Purpose: read the transcript of a given session (read-only; it does not modify the other session nor write any events into it)
- Per-call budget: the `readBytes` config (default 16384 bytes)

Typical exchange:

> You: /ref last week's debugging session, then confirm the conclusion there.
> Agent: (calls session_read to continue reading) … the conclusion is X.

## Configuration

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `send` \| `draft` | `send` | Default delivery: submit the reference message, or only refill the composer draft |
| `maxReferences` | integer (1–5) | `3` | How many sessions a single `/ref` may reference |
| `guidance` | string | `''` | Custom guidance appended to the end of the snapshot reference block; empty means nothing is appended |
| `readBytes` | integer | `16384` | Byte budget for a single `session_read` call |
| `enableReadTool` | boolean | `true` | Whether to register the `session_read` tool |
| `pickMaxChars` | integer | `4000` | Weighted-character ceiling for message-level verbatim forwarding |
| `pickAsciiWeight` | number (0.05–1) | `0.25` | Weight of ASCII characters when computing weighted length |
| `pickReadBytes` | integer | `262144` | Read budget (bytes) for message-level reads |
| `pickKinds` | array | `[user, assistant, tool-result, tool-call, summary]` | Message kinds eligible for forwarding |

## Failure cases

Every failure returns a command **error result**; nothing is written and the target session is never modified:

| Case | Result text (shape) |
| --- | --- |
| No session given | `usage: /ref [--draft\|--send] <session>` |
| No matching session | `no session matched …` |
| Too many candidate sessions | `matched N candidates: …` |
| Referencing the current session itself (session level) | `cannot reference the current session itself … use another session` |
| Target session has nothing to compress | `the target session has no content to reference` |
| Unknown flag | `usage: /ref [--draft\|--send] <session>` |

(Exact wording depends on the host implementation; the common property is that failures are error results — no half-written reference.)

> Session-level self-reference is rejected, but **message-level is allowed** (`--list` / `--pick`): that path is expanded by this plugin's own pre-step and never goes through dsh's session-level snapshot preparation, so "move a few messages of this session into this session" works.

## `draft` mode and fallbacks

- **Web UI**: under `--draft` / `mode: draft`, the client fills the command result's reference text into the composer draft (the plugin registers an invisible session-scoped slot that reads this session's latest `ref` command result and writes it through the public `setDraft` input action). Each result is filled exactly once; if the composer already has your own text it is **not overwritten**, and the command result stays visible so you can copy it.
- **Other surfaces or unavailable client slot**: the host still returns the command result text containing the `dsh-session:` reference and the client injects nothing — copy from the result. Nothing is missing functionally; it is one extra manual step.

## Message-level forwarding (`--list` / `--pick`)

Session-level references compress a whole session into a snapshot; message-level forwarding moves only the messages you specify — handy for "bring that diagnosis over verbatim".

    /ref <session> --list                    # see which messages are forwardable
    /ref <session> --list --limit 50         # 50 per page (max 50)
    /ref <session> --list --before 1180      # page towards older messages
    /ref <session> --list --after 1251       # page towards newer messages
    /ref <session> --pick 12 13              # forward these two verbatim
    /ref <session> --pick 12 13 --compact    # summarize before forwarding
    /ref --draft <session> --pick 12         # fill the draft only

Key points:

- `--pick` takes **seq** (the numeric event sequence); `--list` prints them.
- `--list` and `--pick` read the **raw log**, so messages hidden by context compaction can still be listed and forwarded.
- Selecting a `tool/call` or `tool/result` automatically includes its pair (matched by callId), so you never forward "a result without knowing what was called".
- Without `--compact`, the ceiling uses **weighted characters**: ASCII (English, code, whitespace, punctuation) counts as `pickAsciiWeight` (default 1/4) and everything else counts as 1, with `pickMaxChars` (default 4000) as the threshold. So the same 4000 budget allows roughly 4000 Chinese characters or 16000 ASCII characters — aligning the real cost on the model side. Exceeding it returns an **error that reports both the weighted length and the raw length**; no silent truncation.
- `--compact` performs a real model call (consumes quota); summarization failures are always errors and never silently fall back to the original text.
- Eligible kinds are controlled by `pickKinds`, default `[user, assistant, tool-result, tool-call, summary]`.
- `--list` only lists **user / assistant** dialogue messages by default; widen it with `--kind`, e.g. `--kind user assistant tool-call tool-result summary`. `--kind` with no arguments restores the default; multiple names may be space- or comma-separated, and an unknown short name is an error.

## Per-turn forward panel

Each turn's button row ends with a forward icon (right after "branch into a new conversation"). It moves **this turn's** messages into another session.

### Single-turn forwarding

1. Click the button → pick the target session from the sheet (same session source as bare `/ref`, same search key "title · short id"; the current session carries a "current" tag, archived sessions sort last and require a confirmation).
2. Tick the messages to forward in the dialog. `user` / `assistant` are selected by default; the segmented buttons at the top select or clear a whole kind.
3. Optionally add a note, appended as a plain text line after the references.
4. The footer shows the live weighted length and ceiling. Above the ceiling, **compaction is forced on and cannot be turned off**.
5. Choose "Draft" or "Send": draft refills the target session's composer, send submits directly.

### Multi-turn forwarding (ticking)

To the **right** of the turn-tail forward button there is a checkbox (fully hidden by default; it slides in with a transition when the pointer is over the button group):

- Clicking it selects the **whole turn that message belongs to**: every message of that turn gets a 2px accent bar on the left plus a tinted background, with rounded corners on the first and last rows so it reads as one block.
- A ticked checkbox stays visible after the pointer leaves, and clicking again unticks it.
- At most 5 turns can be ticked at once (a guard against read cost).
- In that state, clicking the forward button of **any** turn opens the union of "ticked turns ∪ the turn the button belongs to", titled like "forward 3 turns → "session"", with a "turn N" tag on every row.
- When nothing is ticked, the button behaves exactly as the original single-turn flow.

> The in-progress turn has no tail button, so it can only join as "the turn the button belongs to", never as a ticked source.

### Data source: snapshot / raw log

A "raw log" switch sits at the right of the panel title:

| Source | Content | Cost |
| --- | --- | --- |
| Snapshot (default) | Client-side chat snapshot; one tool node merges the call and its result | Free, instant |
| Raw log | Host reads raw events; `tool-call` and `tool-result` are merged into one row per call | First read of a turn decompresses the whole log |

- Switching to raw log first fetches a skeleton via the `meta` route ("how many rows, of what kinds", ~0.7 s), then fills the text in batches of 8 with a "loading 20/30" progress label.
- While loading, the segmented buttons, note, compaction switch and Draft/Send are greyed out (they still point at snapshot data); only the source switch stays usable — switching back to snapshot cancels the read.
- The switch remembers the last choice, but **only within the current page lifetime**: after a refresh it is back to snapshot. Opening the panel also probes whether this turn is still cached on the Host and only then reuses raw log, so you never wait for a cold read by surprise.
- Rows with empty bodies (tool-only turns) are skipped and reported at the bottom as "N messages with empty content not listed", matching `--list`.

### Two delivery paths

| Mode | What is refilled/sent | Why |
| --- | --- | --- |
| Draft | One `dsh-session-message:` reference per line (rendered as chips) | Same style as session-level references; content is expanded by `agent/pre-step` **at submit time**, so the draft stays short and click-to-delete |
| Send (uncompressed) | The full forwarded block | Does not depend on pre-step — narrowest chain |
| Send (compacted) | References plus a compact flag | Only the pre-step side can call the model for summarization |

Compaction works through the reference payload carrying `c:1`; seeing it, pre-step calls `summarizeMessages`. **Missing model route, call failure, or an empty stream all fall back to the original text**, never blocking the submit.

### Troubleshooting

When the panel does not open or the list is empty, the console prints `[dsh-session-cite] forward candidates N: seq:kind …`; a button that fails to move into the action row prints "button could not move into the action row"; a failed multi-select install prints "multi-select DOM layer install failed".

## Known limitations

- What enters the message is a **snapshot** (a compressed summary), not the full transcript; finer content requires `session_read`.
- References only affect the current user message; no long-lived subscription or linkage is created.
- `session_read` is bounded by `readBytes`; very long sessions need multiple reads.
- Automatic draft refill only works on Web (`platform: web`), one command result at a time — multiple references are not accumulated.
- Writing content back into the referenced session is not supported (the plugin treats target sessions as strictly read-only).
- On a cold cache, the first raw-log read of a large turn still takes tens of seconds — the skeleton appears early, but the text arrives batch by batch.
- Ticked turns and source preference live in memory only and are cleared on refresh.
- Known upstream behaviour: dsh persists drafts only when the conversation view mounts and never rewrites after sending, so previously **sent** forward chips may reappear in the composer after a refresh. This plugin deliberately does not clean them up (that would risk clearing unsent drafts).

## Changelog

| Version | Highlights |
| --- | --- |
| **1.3.2** | Skeleton loading: new `meta` route (seq/kind only, ~0.7 s); the panel renders the skeleton first and then fills text in batches of 8 with visible progress. The skeleton merges tool calls into one row per call, matching the final granularity. Controls that would act on snapshot data are disabled while loading. |
| **1.3.1** | Cache probing: new O(1) `probe` route (tracked per turn). Opening the panel asks whether this turn is still cached on the Host and reuses raw log only when it is. Source preference moved from localStorage to memory, so a refresh returns to snapshot. |
| **1.3.0** | Multi-turn ticking: a checkbox at the right of the turn-tail forward button, whole-turn highlighting, tick state kept per turn number in memory, 5 turns max. Clicking any turn's forward button opens the union of ticked turns and that turn. |
| **1.2.6** | Compaction summary nodes: fixed dsh's `CompactionSummaryNode` being dropped from the snapshot panel because its body is a `summary` string rather than a block array; `seq` now uses `summaryEventSeq`, and summaries are clipped to their owning turn by seq range. |
| **1.2.5** | UI overhaul: visuals moved from inline styles into a stylesheet (hover / focus / entrance animation / thin scrollbars); layered card, segmented control, gradient primary button; the raw-log loading state now shows a spinner instead of stale rows. |
| **1.2.4** | Self-reference: session-level references to the current session produce a clear message pointing at `--list` / `--pick`; message-level self-reference is allowed; the current session gets a "current" tag in the picker (no longer occupying the `active` highlight slot). |
| **1.2.3** | Turn retrieval: new read-only `GET /api/dsh-session-cite/turn-messages` route (loopback only) so the panel can read the raw log; fixed empty-bodied assistant rows leaking into the list; adjacent `tool-call` + `tool-result` merged into one `tool` row; per-seq in-process event cache (second read of the same turn ~0.3 s). |
| **1.2.2** | Session tree: the picker became a three-level tree (workspace → main session → subagents); subagents are view-only and not selectable; fixed branch sessions being misclassified as subagents. |
| **1.2.1** | Archived sessions: reads the archive plugin's inventory, sorts archived sessions last, dims them, tags them "archived", and asks for confirmation before selecting one. |
| **1.2.0** | Message compaction: `--pick --compact` and the panel's compact switch; the reference payload carries a `c:1` flag so pre-step calls the model, with fallback to the original text on any failure. |
| **1.1.2** | Message-level reference format (`dsh-session-message:`) plus weighted length (`pickAsciiWeight`) for a fairer budget across Chinese and English. |
| **1.1.1** | Session picker: session list mapping, the "title · short id" search key, and the draft-refill pipeline. |
| **1.1.0** | Test suite: unit tests for parsing, rendering, commands and message reading. |
| **0.1.0** | First release: session-level `/ref` references, the `session_read` tool, and Web draft refill; fixed the criterion that made draft refill pick up error output. |
