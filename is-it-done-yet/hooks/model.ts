export type Status = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  active: string
  status: Status
  phase: string
  phaseTitle: string
  // Group names below the phase (wave, sub-section, parent task), outermost first.
  sub?: string[]
  // True for a line read from a plan file: its text is the file's own, so no "P2:" prefix is stripped from it.
  raw?: true
  startedAt: number
  doneAt: number
}

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Snapshot = {
  tasks: Task[]
  tokens: Tokens
  costUsd: number
  goal: string
  startedAt: number
}

export type Stats = {
  total: number
  done: number
  active: number
  todo: number
  pct: number
  elapsedMs: number
  etaMs: number | null
  current: string
  next: string
  allDone: boolean
}

// `tasks` is every task under the group, `direct` those that sit in it with no group of their own below.
export type Group = { key: string; label: string; tasks: Task[]; direct: Task[]; children: Group[]; done: number; active: number }

export const EMPTY_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const MAX_TASKS = 400
const MAX_SUBJECT = 160

// "Phase 2: x", "Faz 2 - x", "[Stage 3] x" ...
const PHASE_WORD = /^\s*\[?\s*(?:phase|faz|aşama|asama|stage|part)\s*(\d+[a-z]?)\s*\]?\s*[:.)\-–—]?\s*(.*)$/i
// "P2: x", "F3 - x": the separator is required so "Fix 3 bugs" is not a phase
const PHASE_SHORT = /^\s*\[?\s*[pf](\d+[a-z]?)\s*\]?\s*[:.)\-–—]\s*(.*)$/i

export function parsePhase(subject: string, metaPhase?: unknown): { phase: string; title: string } {
  const m = PHASE_WORD.exec(subject) ?? PHASE_SHORT.exec(subject)
  const title = m && m[2] ? m[2].trim() : subject.trim()
  if (typeof metaPhase === 'string' && metaPhase.trim() !== '') return { phase: metaPhase.trim().toLowerCase(), title }
  if (typeof metaPhase === 'number' && Number.isFinite(metaPhase)) return { phase: String(metaPhase), title }
  return { phase: m && m[1] ? m[1].toLowerCase() : '', title }
}

export function titleOf(subject: string): string {
  return parsePhase(subject).title
}

// What to show for a task: a plan file's text as written, a session task without its phase prefix.
export function labelOf(t: Task): string {
  return t.raw ? t.subject : titleOf(t.subject)
}

export function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SUBJECT ? `${flat.slice(0, MAX_SUBJECT - 1)}…` : flat
}

function transition(t: Task, status: Status, now: number): Task {
  if (status === t.status) return t
  if (status === 'in_progress') return { ...t, status, startedAt: t.status === 'completed' ? now : t.startedAt || now, doneAt: 0 }
  if (status === 'completed') return { ...t, status, doneAt: now }
  return { ...t, status, startedAt: 0, doneAt: 0 }
}

export function applyCreate(
  tasks: Task[],
  c: { id: string; subject: string; active?: string; phase?: unknown },
): Task[] {
  const subject = clip(c.subject)
  const phase = parsePhase(subject, c.phase).phase
  const fresh: Task = { id: c.id, subject, active: clip(c.active ?? ''), status: 'pending', phase, phaseTitle: '', startedAt: 0, doneAt: 0 }
  const i = tasks.findIndex(t => t.id === c.id)
  const next = i < 0 ? [...tasks, fresh] : tasks.map((t, j) => (j === i ? { ...fresh, status: t.status, startedAt: t.startedAt, doneAt: t.doneAt } : t))
  return next.slice(-MAX_TASKS)
}

export type Update = {
  id: string
  status?: Status | 'deleted'
  subject?: string
  active?: string
  phase?: unknown
}

export function applyUpdate(tasks: Task[], u: Update, now: number): Task[] {
  if (u.status === 'deleted') return tasks.filter(t => t.id !== u.id)
  const i = tasks.findIndex(t => t.id === u.id)
  // The task was created before the mod loaded, or in a session /clear left behind.
  const base: Task =
    i >= 0
      ? (tasks[i] as Task)
      : { id: u.id, subject: clip(u.subject ?? `#${u.id}`), active: '', status: 'pending', phase: '', phaseTitle: '', startedAt: 0, doneAt: 0 }
  let t = base
  if (u.subject !== undefined) {
    const subject = clip(u.subject)
    t = { ...t, subject, phase: parsePhase(subject, u.phase).phase }
  } else if (u.phase !== undefined) {
    t = { ...t, phase: parsePhase(t.subject, u.phase).phase }
  }
  if (u.active !== undefined) t = { ...t, active: clip(u.active) }
  if (u.status !== undefined) t = transition(t, u.status, now)
  if (i < 0) return [...tasks, t].slice(-MAX_TASKS)
  return tasks.map((x, j) => (j === i ? t : x))
}

export type Todo = { content: string; status: Status; activeForm?: string }

// TodoWrite replaces the whole list and carries no ids: match by text to keep each item's timings.
export function applyTodos(prev: Task[], todos: readonly Todo[], now: number): Task[] {
  const pool = [...prev]
  const next = todos.slice(0, MAX_TASKS).map((todo, i): Task => {
    const subject = clip(todo.content)
    const at = pool.findIndex(t => t.subject === subject)
    const old = at >= 0 ? (pool.splice(at, 1)[0] as Task) : undefined
    const base: Task = old ?? { id: `todo-${i + 1}`, subject, active: '', status: 'pending', phase: parsePhase(subject).phase, phaseTitle: '', startedAt: 0, doneAt: 0 }
    return transition({ ...base, active: clip(todo.activeForm ?? '') }, todo.status, now)
  })
  return next
}

export function parseCreateResult(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const task = (result as { task?: unknown }).task
  if (typeof task !== 'object' || task === null) return null
  const id = (task as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

export function isUpdateOk(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return true
  return (result as { success?: unknown }).success !== false
}

// `baseDone` is how many tasks were already done when this session first saw the list: a plan that was
// mostly finished before today must not make the pace look fast.
export function stats(tasks: readonly Task[], startedAt: number, now: number, baseDone = 0): Stats {
  const total = tasks.length
  const done = tasks.filter(t => t.status === 'completed').length
  const active = tasks.filter(t => t.status === 'in_progress').length
  const allDone = total > 0 && done === total
  const lastDone = tasks.reduce((m, t) => Math.max(m, t.doneAt), 0)
  const end = allDone && lastDone > 0 ? lastDone : now
  const elapsedMs = startedAt > 0 ? Math.max(0, end - startedAt) : 0
  const gained = Math.max(0, done - Math.max(0, baseDone))
  const remaining = total - done
  const etaMs = !allDone && gained > 0 && elapsedMs > 0 ? (elapsedMs / gained) * remaining : null
  const cur = tasks.find(t => t.status === 'in_progress')
  const nxt = tasks.find(t => t.status === 'pending')
  return {
    total,
    done,
    active,
    todo: total - done - active,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    elapsedMs,
    etaMs,
    current: cur ? cur.active || labelOf(cur) : '',
    next: nxt ? labelOf(nxt) : '',
    allDone,
  }
}

function phaseOrder(a: string, b: string): number {
  const na = Number.parseInt(a, 10)
  const nb = Number.parseInt(b, 10)
  if (na !== nb) return na - nb
  return a < b ? -1 : a > b ? 1 : 0
}

function node(key: string, label: string, list: Task[], depth: number): Group {
  const direct: Task[] = []
  const byChild = new Map<string, Task[]>()
  for (const t of list) {
    const name = t.sub?.[depth - 1]
    if (name === undefined || name === '') direct.push(t)
    else byChild.set(name, [...(byChild.get(name) ?? []), t])
  }
  return {
    key,
    label,
    tasks: list,
    direct,
    children: [...byChild].map(([name, l]) => node(`${key}/${name}`, name, l, depth + 1)),
    done: list.filter(t => t.status === 'completed').length,
    active: list.filter(t => t.status === 'in_progress').length,
  }
}

// The tasks as a tree: phases, then whatever the plan groups below them (waves, sub-sections, parent tasks).
export function groups(tasks: readonly Task[]): Group[] {
  const byKey = new Map<string, Task[]>()
  for (const t of tasks) {
    const list = byKey.get(t.phase)
    if (list) list.push(t)
    else byKey.set(t.phase, [t])
  }
  const keys = [...byKey.keys()].filter(k => k !== '').sort(phaseOrder)
  if (byKey.has('')) keys.push('')
  return keys.map(key => {
    const list = byKey.get(key) as Task[]
    return node(key, list.find(t => t.phaseTitle !== '')?.phaseTitle ?? (key === '' ? 'Tasks' : `Phase ${key}`), list, 1)
  })
}

// A section is open when the person said so, or when work is happening in it. Of the top-level phases, the first
// unfinished one is open too, and a finished one is folded to its bar; below a phase, whatever is unfinished is.
export function isOpen(g: Group, siblings: readonly Group[], level: number, explicit: Record<string, boolean>): boolean {
  const said = explicit[g.key]
  if (said !== undefined) return said
  if (g.active > 0) return true
  if (level > 1) return g.done < g.tasks.length
  if (siblings.length === 1) return true
  return siblings.find(x => x.done < x.tasks.length)?.key === g.key
}

export function barCells(done: number, active: number, total: number, width: number): [number, number, number] {
  if (total <= 0 || width <= 0) return [0, 0, Math.max(0, width)]
  let d = done >= total ? width : Math.floor((done / total) * width)
  if (done > 0 && d === 0) d = 1
  let a = active > 0 ? Math.max(1, Math.round((active / total) * width)) : 0
  if (d + a > width) a = Math.max(0, width - d)
  if (d > width) d = width
  return [d, a, width - d - a]
}

export function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return '<1 min'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

// A rough figure: whole minutes under 20 min, then the nearest 5 or 10.
export function fmtEta(ms: number): string {
  const min = ms / 60_000
  const step = min < 20 ? 1 : min < 60 ? 5 : 10
  const rounded = Math.max(1, Math.round(min / step) * step)
  return `≈ ${fmtDuration(rounded * 60_000)}`
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function addUsage(t: Tokens, u: unknown): Tokens {
  if (typeof u !== 'object' || u === null) return t
  const x = u as Record<string, unknown>
  return {
    input: t.input + num(x.input_tokens),
    output: t.output + num(x.output_tokens),
    cacheRead: t.cacheRead + num(x.cache_read_input_tokens),
    cacheWrite: t.cacheWrite + num(x.cache_creation_input_tokens),
  }
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

// A saved snapshot is another process's write: keep only what has the right shape.
export function readSnapshot(raw: unknown): Snapshot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.tasks)) return null
  const tasks: Task[] = []
  for (const item of r.tasks.slice(0, MAX_TASKS)) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    if (typeof t.id !== 'string' || typeof t.subject !== 'string' || typeof t.status !== 'string' || !STATUSES.includes(t.status)) continue
    tasks.push({
      id: t.id,
      subject: clip(t.subject),
      active: typeof t.active === 'string' ? clip(t.active) : '',
      status: t.status as Status,
      phase: typeof t.phase === 'string' ? t.phase : '',
      phaseTitle: typeof t.phaseTitle === 'string' ? clip(t.phaseTitle) : '',
      startedAt: num(t.startedAt),
      doneAt: num(t.doneAt),
    })
  }
  const tk = (typeof r.tokens === 'object' && r.tokens !== null ? r.tokens : {}) as Record<string, unknown>
  return {
    tasks,
    tokens: { input: num(tk.input), output: num(tk.output), cacheRead: num(tk.cacheRead), cacheWrite: num(tk.cacheWrite) },
    costUsd: num(r.costUsd),
    goal: typeof r.goal === 'string' ? r.goal.slice(0, 200) : '',
    startedAt: num(r.startedAt),
  }
}

export type ViewMode = 'auto' | 'plan' | 'live'

// A plan file in the project wins by default: it is the project's own account of progress. The person can
// flip to this session's task list, and a mode that has nothing to show falls back to the other.
export function pickSource(mode: ViewMode, planCount: number, liveCount: number): 'plan' | 'live' {
  if (mode === 'live' && liveCount > 0) return 'live'
  if (mode === 'plan' && planCount > 0) return 'plan'
  return planCount > 0 ? 'plan' : 'live'
}
