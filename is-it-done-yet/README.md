# is-it-done-yet
A docked progress pane for long, multi-phase agent work, for a new plan or a project already underway: percent done, phases and tasks with colour bars, elapsed time, a rough ETA, tokens used and the API-equivalent cost. The repository README ([../README.md](../README.md)) has the pictures and the full guide; this file is the plugin's reference: what it reads, what it can reach, how it is built.

Built against the Claude Code 2.1.295 declarations. The test suite (see DECISIONS.md for what was and was not run) passes on 2.1.299. Requires Claude Code 2.1.287 or later.

## Where the list comes from

1. **The markdown files in the folder**, scanned on load and on every `/progress`: the `.md` / `.markdown` / `.mdx` files up to three folders deep, newest first (at most 250 files and 3 MB read, each at most 256 KB), never inside `node_modules` or `.git`, never through a link. No file names are built in. A file is a candidate when it holds at least two trackable items; candidates are ranked by their content (the title and first lines, the headings, the number of items, the mix of done and not done, how recent the file is) and the best eight are kept. The best one is followed; the ⇄ button moves to the next, `/progress plan` lists them, `/progress plan <file>` pins one (stored per project). A followed file is re-read when its modification time changes: after every turn, and every 30 s while the pane is open; the others are compared again every ten minutes.
   - Checkboxes: `- [x]` done, `- [~]` or `- [/]` in progress, `- [ ]` and `- [>]` not started, `- [-]` cancelled (left out). Status symbols and tags work the same: `✅ ☑ ✔ 🟢` done, `🔄 ⏳ 🚧 🟡 [WIP]` in progress, `⬜ ☐ 🔲 📋 [TODO]` not started, `❌` left out. Bullets and numbered lists both count; fenced code is ignored.
   - A heading is a phase (the shallowest heading level below the title that holds items). An item with items nested under it is a phase instead of a task.
   - A file with no checkboxes but a table with a `Status`/`Durum` column is read as a status table.
2. **The session's task tools**: `TaskCreate`, `TaskUpdate`, `TodoWrite`, watched live. A mod loaded mid-session, or a `/resume`, replays the task calls found in the transcript. Phases come from a title prefix (`Phase 2:`, `Faz 2 -`, `[Stage 3]`, `P2:`) or a `phase` key in `metadata`.

The best-ranked file wins when a session list also exists; the ⇄ button flips. Token and API figures are session totals either way.

## Commands

| Command | Does |
|---|---|
| `/progress` | open the pane, or close it if it is open (registered `immediate`, so it can run mid-turn); also re-reads the plan |
| `/progress open`, `/progress close` | the same, explicitly |
| `/progress plan` | list the candidate plan files with their progress |
| `/progress plan <file>` | follow one file inside the project and open the pane; `/progress plan auto` goes back to the best guess |
| `/progress goal <text>` | set the title; with no text, back to the folder name |
| `/progress reset` | clear the session's task list and restart its clock |

## What it can reach

    ❯ ./register.ts hooks: session.start, classic.SessionStart{source=clear|resume|fork}, tool.call{tool=TaskCreate}, tool.call{tool=TaskUpdate}, tool.call{tool=TodoWrite}, turn.complete, command.run{command=progress}, ui.render{component=Pane, requestId=progress}
    ❯ ./register.ts calls: $.clock.every, $.clock.now, $.command.register, $.fs.list, $.fs.read, $.fs.stat, $.session.cwd, $.session.id, $.session.messages, $.session.usage, $.state.get, $.state.set, $.store.get, $.store.set, $.ui.close, $.ui.log, $.ui.open, $.ui.panes, $.ui.resolve

Reach L1, reads (reads files, reads the transcript, persists state, draws).

    Threat model for is-it-done-yet (reach L1, reads)
    1. Reads:    the markdown files of the project folder (up to three folders deep, never node_modules or .git, regular files only, at most 250 files, 256 KB each and 3 MB in all), and the one file you pin with /progress plan (which must resolve to a path inside the project); the session transcript (the task tools' calls only are used); the task tools' calls and results; each turn's token counts; the session's running cost; the session id and folder name; its own state keys and store keys; no env, settings or other files
    2. Runs:     nothing
    3. Sends:    nothing leaves the machine
    4. Persists: $.state for the session; one $.store key per session (s-<session id>: up to 400 tasks of at most 160 characters, token totals, cost, goal) and one per pinned project (pin:<folder>: the file name you gave), kept until deleted or cleanupPeriodDays unread; writes no files
    5. Hostile input: plan files and task subjects are written by the repository or the model and can say anything; they are only parsed into task titles (markdown stripped, whitespace collapsed, 160 characters) and drawn as Text, never executed, written to a file, sent anywhere or put in the model's context, so crafted text can only change what the pane shows; a link is never followed, a pinned path that resolves outside the folder (`..`, a link) or is not a regular file, and anything over 256 KB, are skipped; a saved snapshot is shape-checked and capped on load

## Install

One session: `claude --plugin-dir ./is-it-done-yet`. To keep it: `claude plugin marketplace add gclbck-crealore/gclbck-crealore-mods`, then `claude plugin install is-it-done-yet@gclbck-crealore-mods` (this repository is also a marketplace of its own: `gclbck-crealore/is-it-done-yet-mod`), then run `/reload-plugins` in an open session. Installed copies are cached by version: bump `version` before reinstalling.

## Options
autoOpen: open the pane by itself when a plan file is found at startup and the first time the agent creates a task, when the terminal is wide enough (144 columns, or 110 once you have opened it yourself); default on. `/progress` always works at any width. Stored under `pluginConfigs` in settings; a change reloads the mod.

## Limitations
- The ETA is crude: time this session has run divided by the tasks it finished, times tasks left. Tasks of very different size make it wrong; it is hidden until this session has finished one.
- Progress is read from checkboxes, status symbols and status tables; prose and plain numbered steps carry no status. More than 400 items are cut.
- Which file is the plan is a ranked guess from the file's content (title, first lines, headings, mix of done and not done, recency). In a folder with many checklists the first guess can be wrong; ⇄ and `/progress plan <file>` fix that.
- Tasks replayed from the transcript carry no timestamps.
- After `/clear` the session list starts empty (a new session) while the project plan is read again; after `/resume` the saved list comes back.
- The restore hook is a `classic.SessionStart` hook, which does not run in an installed mod where an organisation manages Claude Code.
- The pane draws in the terminal and the Desktop Code tab. In `claude -p`, the SDK, the VS Code panel and cloud sessions nothing is drawn; `/progress` then answers `the pane waits (…)` or does nothing.
- Elapsed time is wall-clock, so time you spend away counts.
- Colours are hex values; a terminal without true colour approximates them.

## Uninstall
Disable it in `/plugin`. It leaves: `$.store` keys `s-<session id>` and `pin:<folder>`, which expire on their own after `cleanupPeriodDays` unread.
