import { applyCreate, applyTodos, applyUpdate, clip, isUpdateOk, parseCreateResult, type Status, type Task, type Todo } from './model.js'

const MAX_TASKS = 400

// "- [ ] text", "* [x] text", "1. [~] text"
const BOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX~/>.\-])\]\s+(.*\S)\s*$/
const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/

type Item = { indent: number; mark: string; text: string; head: number }
type Head = { level: number; text: string; own: number }

// Strip the markdown a title doesn't need on a one-line pane: emphasis, code ticks, link targets.
export function cleanTitle(s: string): string {
  return clip(
    s
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\s+/g, ' '),
  )
}

function width(indent: string): number {
  return indent.replace(/\t/g, '    ').length
}

function statusOfMark(mark: string): Status | null {
  if (mark === 'x' || mark === 'X') return 'completed'
  if (mark === '~' || mark === '/') return 'in_progress'
  if (mark === '-') return null // cancelled: not part of the plan any more
  return 'pending'
}

function taskOf(n: number, text: string, status: Status, phase: string, phaseTitle: string): Task {
  return { id: `f${n}`, subject: cleanTitle(text), active: '', status, phase, phaseTitle, startedAt: 0, doneAt: 0 }
}

// Checkbox lists, grouped under the plan's headings. A checkbox that has checkboxes nested under it is a phase
// of its own (the GSD roadmap style: "- [x] **Phase 1** …" with the work beneath), not a task.
function parseCheckboxes(lines: readonly string[]): Task[] {
  const heads: Head[] = []
  const items: Item[] = []
  let fenced = false
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const h = HEAD.exec(raw)
    if (h) {
      heads.push({ level: (h[1] as string).length, text: cleanTitle(h[2] as string), own: 0 })
      continue
    }
    const b = BOX.exec(raw)
    if (b) {
      items.push({ indent: width(b[1] as string), mark: b[2] as string, text: b[3] as string, head: heads.length - 1 })
      const last = heads[heads.length - 1]
      if (last) last.own += 1
    }
  }
  if (items.length === 0) return []

  // The phase level is the shallowest heading (below the title) that holds checkboxes itself.
  const holders = heads.filter(h => h.own > 0)
  const deep = holders.filter(h => h.level >= 2)
  const phaseLevel = deep.length > 0 ? Math.min(...deep.map(h => h.level)) : holders.length > 0 ? Math.min(...holders.map(h => h.level)) : 0

  const order = new Map<string, { key: string; title: string }>()
  const phaseFor = (id: string, title: string) => {
    let p = order.get(id)
    if (!p) {
      p = { key: String(order.size + 1).padStart(2, '0'), title }
      order.set(id, p)
    }
    return p
  }

  const tasks: Task[] = []
  const stack: { indent: number; id: string; title: string }[] = []
  items.forEach((it, i) => {
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= it.indent) stack.pop()
    const nxt = items[i + 1]
    if (nxt && nxt.head === it.head && nxt.indent > it.indent) {
      stack.push({ indent: it.indent, id: `c${i}`, title: cleanTitle(it.text) })
      return
    }
    const status = statusOfMark(it.mark)
    if (status === null) return
    const top = stack[stack.length - 1]
    let phase = { key: '', title: '' }
    if (top) phase = phaseFor(top.id, top.title)
    else if (phaseLevel > 0) {
      let k = it.head
      while (k >= 0 && (heads[k] as Head).level > phaseLevel) k -= 1
      if (k >= 0) phase = phaseFor(`h${k}`, (heads[k] as Head).text)
    }
    tasks.push(taskOf(tasks.length + 1, it.text, status, phase.key, phase.title))
  })
  return tasks.slice(0, MAX_TASKS)
}

function statusOfCell(cell: string): Status | null {
  if (/❌|✗|cancel|iptal|skip|drop/i.test(cell)) return null
  if (/⬜|☐|🔲|⏸|to ?do|pending|not (started|done)|planned|bekliyor|yapılacak|başlamadı/i.test(cell)) return 'pending'
  if (/🔄|⏳|🚧|🟡|in[ -]?progress|wip|doing|devam|sürüyor/i.test(cell)) return 'in_progress'
  if (/✅|☑|✔|🟢|done|complete|bitti|tamam/i.test(cell)) return 'completed'
  return null
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())

// Status tables ("| Phase | Status |"), used only when the file has no checkboxes at all.
function parseTables(lines: readonly string[]): Task[] {
  const tasks: Task[] = []
  let heading = ''
  let col = -1
  let fenced = false
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced
    if (fenced) continue
    const h = HEAD.exec(raw)
    if (h) {
      heading = cleanTitle(h[2] as string)
      col = -1
      continue
    }
    if (!raw.trim().startsWith('|')) {
      col = -1
      continue
    }
    const row = cells(raw)
    if (col < 0) {
      const at = row.findIndex(c => /status|durum/i.test(c))
      if (at >= 0 && /^\s*\|?[\s:|-]+\|?\s*$/.test((lines[i + 1] as string | undefined) ?? '')) col = at
      continue
    }
    if (/^[\s:-]+$/.test(row.join(''))) continue
    const status = statusOfCell(row[col] ?? '')
    const title = row.find((c, k) => k !== col && c !== '')
    if (status === null || title === undefined) continue
    tasks.push(taskOf(tasks.length + 1, title, status, heading === '' ? '' : '01', heading))
  }
  // One phase per table heading would need ordering keys; a single key per heading is enough for a group.
  const keys = [...new Set(tasks.map(t => t.phaseTitle))]
  return tasks.slice(0, MAX_TASKS).map(t => ({ ...t, phase: t.phaseTitle === '' ? '' : String(keys.indexOf(t.phaseTitle) + 1).padStart(2, '0') }))
}

export function parsePlan(markdown: string): Task[] {
  const lines = markdown.split(/\r?\n/)
  const boxes = parseCheckboxes(lines)
  return boxes.length > 0 ? boxes : parseTables(lines)
}

type UseSummary = { tool: string; input: Record<string, unknown>; result?: unknown; isError?: true }

const STATUS = ['pending', 'in_progress', 'completed', 'deleted'] as const
const isStatus = (v: unknown): v is (typeof STATUS)[number] => typeof v === 'string' && (STATUS as readonly string[]).includes(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function phaseOf(metadata: unknown): unknown {
  return typeof metadata === 'object' && metadata !== null ? (metadata as { phase?: unknown }).phase : undefined
}

// Replays the task tools' calls found in the transcript, for a mod loaded after the work began (a reload, a
// resume). The transcript has no timestamps, so timings stay unknown.
export function rebuildFromTranscript(messages: readonly { toolUses: readonly UseSummary[] }[]): Task[] {
  let tasks: Task[] = []
  for (const m of messages) {
    for (const u of m.toolUses) {
      if (u.isError) continue
      if (u.tool === 'TaskCreate') {
        const id = parseCreateResult(u.result)
        const subject = str(u.input.subject)
        if (id !== null && subject !== undefined) tasks = applyCreate(tasks, { id, subject, active: str(u.input.activeForm), phase: phaseOf(u.input.metadata) })
      } else if (u.tool === 'TaskUpdate') {
        const id = u.input.taskId
        if (!isUpdateOk(u.result) || (typeof id !== 'string' && typeof id !== 'number')) continue
        tasks = applyUpdate(
          tasks,
          { id: String(id), status: isStatus(u.input.status) ? u.input.status : undefined, subject: str(u.input.subject), active: str(u.input.activeForm), phase: phaseOf(u.input.metadata) },
          0,
        )
      } else if (u.tool === 'TodoWrite' && Array.isArray(u.input.todos)) {
        const todos: Todo[] = []
        for (const t of u.input.todos as unknown[]) {
          if (typeof t !== 'object' || t === null) continue
          const x = t as { content?: unknown; status?: unknown; activeForm?: unknown }
          if (typeof x.content === 'string' && (x.status === 'pending' || x.status === 'in_progress' || x.status === 'completed')) {
            todos.push({ content: x.content, status: x.status, activeForm: str(x.activeForm) })
          }
        }
        tasks = applyTodos(tasks, todos, 0)
      }
    }
  }
  return tasks
}
