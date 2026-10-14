import { applyCreate, applyTodos, applyUpdate, clip, isUpdateOk, parseCreateResult, type Status, type Task, type Todo } from './model.js'

const MAX_TASKS = 400

// "- [ ] text", "* [x] text", "1. [~] text"
const BOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX~/>.\-])\]\s+(.*\S)\s*$/
const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/

// "- ✅ text", "1. 🔄 text", "- [WIP] text": a status written as a symbol or tag instead of a checkbox
const TAG = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\*\*)?(✅|☑\uFE0F?|✔\uFE0F?|🟢|🔄|⏳|🚧|🟡|⬜|☐|🔲|⏸\uFE0F?|📋|❌|\[(?:done|todo|wip|doing|in progress|open)\])(?:\*\*)?\s*[:\-–—]?\s*(.*\S)\s*$/iu
const TAG_MARK: Record<string, string> = {
  '✅': 'x', '☑': 'x', '✔': 'x', '🟢': 'x', '[done]': 'x',
  '🔄': '~', '⏳': '~', '🚧': '~', '🟡': '~', '[wip]': '~', '[doing]': '~', '[in progress]': '~',
  '⬜': ' ', '☐': ' ', '🔲': ' ', '⏸': ' ', '📋': ' ', '[todo]': ' ', '[open]': ' ',
  '❌': '-',
}

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
    const t = b ? null : TAG.exec(raw)
    const found = b ? { indent: b[1] as string, mark: b[2] as string, text: b[3] as string } : t ? { indent: t[1] as string, mark: TAG_MARK[(t[2] as string).replace(/\uFE0F/g, '').toLowerCase()] ?? ' ', text: t[3] as string } : null
    if (found) {
      items.push({ indent: width(found.indent), mark: found.mark, text: found.text, head: heads.length - 1 })
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


// ---- which markdown file is the project's plan? Judged by what the file says, never by what it is called ----

const word = (alts: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'iu')

// What a plan, a progress note or a task list talks about, in English and Turkish.
const INTENT: RegExp[] = [
  word(['plans?', 'planning', 'roadmap', 'milestones?', 'phases?', 'sprints?', 'schedule', 'timeline', 'yol haritası', 'planı', 'planlar\\p{L}*', 'aşama\\p{L}*', 'faz', 'fazlar', 'fazı']),
  word(['to-?do', 'tasks?', 'checklist', 'backlog', 'action items', 'next steps', 'deliverables?', 'kontrol listesi', 'yapılacak\\p{L}*', 'görev\\p{L}*']),
  word(['progress', 'status', 'tracker', 'tracking', 'completed', 'remaining', 'done', 'ilerleme\\p{L}*', 'durum\\p{L}*', 'tamamlan\\p{L}*', 'kalan\\p{L}*']),
  word(['goals?', 'objectives?', 'acceptance criteria', 'definition of done', 'scope', 'hedef\\p{L}*', 'kapsam\\p{L}*']),
]
// Documents that often hold checkboxes but are not what is being worked through.
const NOT_A_PLAN = word(['reviews?', 'audit\\p{L}*', 'changelog', 'architecture', 'readme', 'retrospective', 'report', 'score', 'facts', 'decisions?', 'notes'])

export type Reading = { title: string; head: string; headings: string[] }

// The title and the first few lines say what a document is for; the headings say what it is made of.
export function readHead(markdown: string): Reading {
  const lines = markdown.split(/\r?\n/)
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---')
    if (end > 0) i = end + 1
  }
  const headings: string[] = []
  const first: string[] = []
  let title = ''
  let fenced = false
  for (; i < lines.length; i += 1) {
    const raw = lines[i] as string
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const h = HEAD.exec(raw)
    if (h) {
      const text = cleanTitle(h[2] as string)
      if (title === '') title = text
      if (headings.length < 60) headings.push(text)
    }
    if (first.length < 4 && raw.trim() !== '') first.push(cleanTitle(raw.replace(/^[#>\s]+/, '')))
  }
  return { title: title !== '' ? title : (first[0] ?? ''), head: first.join(' \n '), headings }
}

export type Scored = { score: number; title: string }

// A file with several trackable items is a candidate; this orders the candidates. Content decides: how many
// items, whether some are done and some not, whether its title and first lines talk about a plan, progress
// or tasks, whether its headings do, and how recently it was touched.
export function scorePlan(markdown: string, tasks: readonly Task[], mtimeMs: number, now: number): Scored {
  const r = readHead(markdown)
  const n = tasks.length
  const done = tasks.filter(t => t.status === 'completed').length
  const active = tasks.filter(t => t.status === 'in_progress').length
  let score = Math.min(n, 30)
  if (done > 0 && done < n) score += 15
  if (active > 0) score += 8
  const rest = r.head.split(' \n ').slice(1).join(' ')
  for (const g of INTENT) {
    if (g.test(r.title)) score += 18
    else if (g.test(rest)) score += 10
  }
  score += Math.min(10, 2 * r.headings.filter(h => INTENT.some(g => g.test(h))).length)
  const ageDays = Math.max(0, now - mtimeMs) / 86_400_000
  score += Math.max(0, 10 - ageDays)
  if (NOT_A_PLAN.test(r.title)) score -= 15
  return { score: Math.round(score * 10) / 10, title: r.title }
}
