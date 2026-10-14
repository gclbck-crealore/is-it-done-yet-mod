import type { Hook, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import {
  EMPTY_TOKENS,
  addUsage,
  applyCreate,
  applyTodos,
  applyUpdate,
  isUpdateOk,
  parseCreateResult,
  pickSource,
  readSnapshot,
  type Task,
  type Tokens,
  type Update,
  type ViewMode,
} from './model.js'
import { parsePlan, rebuildFromTranscript } from './plan.js'
import { renderPane } from './view.js'

type Api = Parameters<Hook<'session.start'>>[0]
type Found = { path: string; mtimeMs: number; tasks: Task[] }

const PANE = 'progress'
const PULSE_MS = 30_000
const RESCAN_MS = 60_000
const MAX_PLAN_BYTES = 512 * 1024

// Where a project keeps its plan, most specific first. The newest file wins among those that parse.
const PLAN_FILES = [
  'PLAN.md', 'plan.md', 'PLANS.md', 'TODO.md', 'todo.md', 'TASKS.md', 'tasks.md', 'ROADMAP.md', 'roadmap.md',
  'PROGRESS.md', 'docs/PLAN.md', 'docs/plan.md', 'docs/ROADMAP.md', 'docs/TODO.md', '.planning/ROADMAP.md',
  '.claude/PLAN.md', '.claude/plan.md',
]
const PLAN_DIRS = ['docs/superpowers/plans', 'docs/plans', 'plans', '.claude/plans']

const tasks = atom({ plugin: 'is-it-done-yet', key: 'tasks' } as const, [] as Task[])
const tokens = atom({ plugin: 'is-it-done-yet', key: 'tokens' } as const, EMPTY_TOKENS as Tokens)
const costUsd = atom({ plugin: 'is-it-done-yet', key: 'costUsd' } as const, 0)
const goal = atom({ plugin: 'is-it-done-yet', key: 'goal' } as const, '')
const startedAt = atom({ plugin: 'is-it-done-yet', key: 'startedAt' } as const, 0)
const expanded = atom({ plugin: 'is-it-done-yet', key: 'expanded' } as const, {} as Record<string, boolean>)
const tick = atom({ plugin: 'is-it-done-yet', key: 'tick' } as const, 0)
const planPath = atom({ plugin: 'is-it-done-yet', key: 'planPath' } as const, '')
const planMtime = atom({ plugin: 'is-it-done-yet', key: 'planMtime' } as const, 0)
const planTasks = atom({ plugin: 'is-it-done-yet', key: 'planTasks' } as const, [] as Task[])
const planBase = atom({ plugin: 'is-it-done-yet', key: 'planBase' } as const, -1)
const view = atom({ plugin: 'is-it-done-yet', key: 'view' } as const, 'auto' as ViewMode)
const lastScan = atom({ plugin: 'is-it-done-yet', key: 'lastScan' } as const, 0)

// TaskCreate / TaskUpdate carry free-form metadata; a `phase` key there overrides the subject prefix.
function phaseOf(metadata: unknown): unknown {
  return typeof metadata === 'object' && metadata !== null ? (metadata as { phase?: unknown }).phase : undefined
}

// ---- the session's own task list -------------------------------------------------------------------------

// One store key per session: the store is shared by every session on the machine.
async function persist($: Api): Promise<void> {
  const id = await $.session.id()
  await $.store.set(`s-${id}`, {
    tasks: await read($, tasks),
    tokens: await read($, tokens),
    costUsd: await read($, costUsd),
    goal: await read($, goal),
    startedAt: await read($, startedAt),
  })
}

async function restore($: Api): Promise<boolean> {
  const id = await $.session.id()
  const snap = readSnapshot(await $.store.get(`s-${id}`))
  if (snap === null || snap.tasks.length === 0) return false
  await update($, tasks, () => snap.tasks)
  await update($, tokens, () => snap.tokens)
  await update($, costUsd, () => snap.costUsd)
  await update($, goal, () => snap.goal)
  await update($, startedAt, () => snap.startedAt)
  return true
}

// A mod loaded after the work began (a reload, a resume) replays the task tools' calls from the transcript.
async function rebuild($: Api): Promise<void> {
  const messages = await $.session.messages().catch(() => [])
  const list = rebuildFromTranscript(messages)
  if (list.length === 0) return
  const used = await $.session.usage()
  await update($, tasks, () => list)
  await update($, startedAt, v => v || used.startedAt)
  await persist($)
}

// The clock starts at the first task the agent writes; the pane opens by itself then, if the terminal is wide enough.
async function noteStart($: Api, autoOpen: boolean): Promise<void> {
  if ((await read($, startedAt)) !== 0) return
  const now = await $.clock.now()
  await update($, startedAt, v => v || now)
  if (autoOpen) await $.ui.open({ id: PANE, title: 'Progress' })
}

async function onCreate($: Api, c: { id: string; subject: string; active?: string; phase?: unknown }, autoOpen: boolean): Promise<void> {
  await update($, tasks, cur => applyCreate(cur, c))
  await noteStart($, autoOpen)
  await persist($)
}

async function onUpdate($: Api, u: Update, autoOpen: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, tasks, cur => applyUpdate(cur, u, now))
  if (u.status === 'in_progress' || u.status === 'completed') await noteStart($, autoOpen)
  await persist($)
}

async function onTodos($: Api, todos: Parameters<typeof applyTodos>[1], autoOpen: boolean): Promise<void> {
  const now = await $.clock.now()
  await update($, tasks, cur => applyTodos(cur, todos, now))
  await noteStart($, autoOpen)
  await persist($)
}

async function newPlan($: Api): Promise<void> {
  await update($, tasks, () => [])
  await update($, startedAt, () => 0)
  await update($, expanded, () => ({}))
  await update($, goal, () => '')
  await persist($)
}

// ---- the project's plan file -----------------------------------------------------------------------------

async function realRoot($: Api): Promise<string | undefined> {
  const st = await $.fs.stat('.', { resolve: true }).catch(() => undefined)
  return st?.realPath
}

// A plan file is read only when it is a regular file, small, and really lives inside the project folder
// (a symlink out of it does not count).
async function fileInfo($: Api, root: string, path: string): Promise<{ mtimeMs: number; real: string } | null> {
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (st === undefined || st.kind !== 'file' || st.size > MAX_PLAN_BYTES) return null
  if (st.realPath === undefined || !st.realPath.startsWith(`${root}/`)) return null
  return { mtimeMs: st.mtimeMs, real: st.realPath }
}

async function candidateNames($: Api): Promise<string[]> {
  const names = [...PLAN_FILES]
  for (const dir of PLAN_DIRS) {
    const entries = await $.fs.list(dir).catch(() => [])
    const newest = entries.filter(e => e.kind === 'file' && /\.md$/i.test(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (newest) names.push(`${dir}/${newest.name}`)
  }
  return names
}

async function scan($: Api, cwd: string): Promise<Found | null> {
  const root = await realRoot($)
  if (root === undefined) return null
  const pinned = await $.store.get(`pin:${cwd}`)
  const isPinned = typeof pinned === 'string' && pinned !== ''
  const names = isPinned ? [pinned] : await candidateNames($)
  const seen = new Set<string>()
  let best: Found | null = null
  for (const name of names) {
    const info = await fileInfo($, root, name)
    if (info === null || seen.has(info.real)) continue
    seen.add(info.real)
    const parsed = parsePlan(await $.fs.read(name).catch(() => ''))
    if (parsed.length < (isPinned ? 1 : 2)) continue
    if (best === null || info.mtimeMs > best.mtimeMs) best = { path: name, mtimeMs: info.mtimeMs, tasks: parsed }
  }
  return best
}

async function setPlan($: Api, found: Found | null): Promise<void> {
  if (found === null) {
    await update($, planPath, () => '')
    await update($, planMtime, () => 0)
    await update($, planTasks, () => [])
    await update($, planBase, () => -1)
    return
  }
  const same = (await read($, planPath)) === found.path
  await update($, planPath, () => found.path)
  await update($, planMtime, () => found.mtimeMs)
  await update($, planTasks, () => found.tasks)
  // What was already done when this session first saw the plan is not this session's pace.
  if (!same || (await read($, planBase)) < 0) {
    const done = found.tasks.filter(t => t.status === 'completed').length
    await update($, planBase, () => done)
  }
}

// Cheap when nothing changed: one stat of the followed file. With no plan found yet it rescans at most once a minute.
async function refreshPlan($: Api, force: boolean): Promise<void> {
  const path = await read($, planPath)
  if (!force && path !== '') {
    const st = await $.fs.stat(path).catch(() => undefined)
    if (st !== undefined && st.mtimeMs === (await read($, planMtime))) return
    if (st !== undefined) {
      const text = await $.fs.read(path).catch(() => undefined)
      const parsed = text === undefined ? [] : parsePlan(text)
      if (parsed.length > 0) {
        await setPlan($, { path, mtimeMs: st.mtimeMs, tasks: parsed })
        return
      }
    }
  }
  const now = await $.clock.now()
  if (!force && path === '' && now - (await read($, lastScan)) < RESCAN_MS) return
  await update($, lastScan, () => now)
  await setPlan($, await scan($, await $.session.cwd()))
}

// Follow one file instead of guessing. It must be a plan the parser understands, inside the project.
async function pinPlan($: Api, rel: string): Promise<string> {
  const root = await realRoot($)
  const info = root === undefined ? null : await fileInfo($, root, rel)
  if (info === null) return `${rel} is not a readable file inside this project (512 KB at most)`
  const parsed = parsePlan(await $.fs.read(rel).catch(() => ''))
  if (parsed.length === 0) return `no checkbox items ("- [ ]") or status table found in ${rel}`
  await $.store.set(`pin:${await $.session.cwd()}`, rel)
  await setPlan($, { path: rel, mtimeMs: info.mtimeMs, tasks: parsed })
  await update($, view, () => 'plan')
  return `following ${rel} (${parsed.length} tasks)`
}

async function bootstrap($: Api): Promise<void> {
  await refreshPlan($, true)
  if ((await read($, tasks)).length > 0) return
  if (await restore($)) return
  await rebuild($)
}

// ---- the pane --------------------------------------------------------------------------------------------

// Elapsed time and the ETA move without any event; redraw only while the pane is open and work remains.
async function pulse($: Api): Promise<void> {
  const panes = await $.ui.panes()
  if (!panes.some(p => p.id === PANE)) return
  await refreshPlan($, false)
  const open = (list: readonly Task[]) => list.some(t => t.status !== 'completed')
  if (open(await read($, tasks)) || open(await read($, planTasks))) await update($, tick, n => n + 1)
}

async function openPane($: Api): Promise<string | undefined> {
  await refreshPlan($, true)
  const opened = await $.ui.open({ id: PANE, title: 'Progress' })
  return opened.isPlaced ? undefined : `the pane waits (${opened.reason})`
}

async function togglePane($: Api): Promise<string | undefined> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return undefined
  }
  return openPane($)
}

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await bootstrap($).catch(err => {
      $.ui.log(`is-it-done-yet: could not read the project's plan (${String(err)})`, { to: 'debug' })
    })
    // A project that already has a plan shows it at once (only where an unasked pane fits: 144 columns).
    if (autoOpen && (await read($, planTasks)).length > 0) await $.ui.open({ id: PANE, title: 'Progress' })
    $.clock.every(PULSE_MS, () => {
      void pulse($)
    })
    await $.command.register({
      name: 'progress',
      description: 'Toggle the progress pane (plan <file> | goal <text> | reset | open | close)',
      immediate: true,
    })
    return started
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await bootstrap($).catch(err => {
      $.ui.log(`is-it-done-yet: could not restore the plan (${String(err)})`, { to: 'debug' })
    })
    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) {
      const id = parseCreateResult(r.result)
      if (id !== null) await onCreate($, { id, subject: e.subject, active: e.activeForm, phase: phaseOf(e.metadata) }, autoOpen)
    }
    return r
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && isUpdateOk(r.result)) {
      await onUpdate($, { id: e.taskId, status: e.status, subject: e.subject, active: e.activeForm, phase: phaseOf(e.metadata) }, autoOpen)
    }
    return r
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) await onTodos($, e.todos, autoOpen)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.usage) await update($, tokens, t => addUsage(t, e.usage))
    const used = await $.session.usage()
    if (used.cost) {
      const usd = used.cost.usd
      await update($, costUsd, () => usd)
    }
    await persist($)
    // The agent often ticks boxes in the plan file itself; pick that up after every turn.
    await refreshPlan($, false)
    return out
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reset') {
      await newPlan($)
      return { text: 'session task list cleared, the clock starts again with the next task' }
    }
    if (arg === 'plan' || arg.startsWith('plan ')) {
      const rel = arg.slice(4).trim()
      if (rel === '' || rel === 'auto') {
        await $.store.set(`pin:${await $.session.cwd()}`, '')
        await update($, view, () => 'auto')
        await refreshPlan($, true)
        return { text: 'looking for the project plan on its own again' }
      }
      const said = await pinPlan($, rel)
      if (!said.startsWith('following')) return { text: said }
      const waits = await openPane($)
      return { text: waits === undefined ? said : `${said}; ${waits}` }
    }
    if (arg === 'goal' || arg.startsWith('goal ')) {
      const text = arg.slice(4).trim().slice(0, 120)
      await update($, goal, () => text)
      await persist($)
      return {}
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    const note = arg === 'open' ? await openPane($) : await togglePane($)
    return note === undefined ? {} : { text: note }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    await read($, tick)
    const cwd = await $.session.cwd()
    const title = await read($, goal)
    const live = await read($, tasks)
    const plan = await read($, planTasks)
    const path = await read($, planPath)
    const source = pickSource(await read($, view), plan.length, live.length)
    const used = await $.session.usage()
    return renderPane(
      el,
      {
        tasks: source === 'plan' ? plan : live,
        tokens: await read($, tokens),
        costUsd: await read($, costUsd),
        goal: title !== '' ? title : cwd.split('/').filter(Boolean).pop() ?? 'Goal',
        startedAt: source === 'plan' ? used.startedAt : await read($, startedAt),
        expanded: await read($, expanded),
        now: await $.clock.now(),
        columns: e.props.bodyColumns,
        source,
        sourceLabel: source === 'plan' ? path : 'Session tasks',
        other:
          source === 'plan'
            ? live.length > 0
              ? { label: 'Session tasks', count: live.length }
              : null
            : plan.length > 0
              ? { label: path, count: plan.length }
              : null,
        baseDone: source === 'plan' ? Math.max(0, await read($, planBase)) : 0,
      },
      {
        toggle: (key, open) => {
          void update($, expanded, cur => ({ ...cur, [key]: open }))
        },
        close: () => {
          void $.ui.close({ id: PANE })
        },
        switchSource: () => {
          void update($, view, () => (source === 'plan' ? 'live' : 'plan'))
        },
      },
    )
  })
}
