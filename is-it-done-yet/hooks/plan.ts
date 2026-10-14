import { applyCreate, applyTodos, applyUpdate, clip, isUpdateOk, parseCreateResult, type Status, type Task, type Todo } from './model.js'

const MAX_TASKS = 400
// A group inside a group inside a group is as deep as a 40-column pane can show.
const MAX_SUB = 2

// "- [ ] text", "* [x] text", "1. [~] text"
const BOX = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX~/>.\-])\]\s+(.*\S)\s*$/
const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/

// "- ✅ text", "1. 🔄 text", "- [WIP] text": a status written as a symbol or tag instead of a checkbox
const TAG = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\*\*)?(✅|☑️?|✔️?|🟢|🔄|⏳|🚧|🟡|⬜|☐|🔲|⏸️?|📋|❌|\[(?:done|todo|wip|doing|in progress|open)\])(?:\*\*)?\s*[:\-–—]?\s*(.*\S)\s*$/iu
const TAG_MARK: Record<string, string> = {
  '✅': 'x', '☑': 'x', '✔': 'x', '🟢': 'x', '[done]': 'x',
  '🔄': '~', '⏳': '~', '🚧': '~', '🟡': '~', '[wip]': '~', '[doing]': '~', '[in progress]': '~',
  '⬜': ' ', '☐': ' ', '🔲': ' ', '⏸': ' ', '📋': ' ', '[todo]': ' ', '[open]': ' ',
  '❌': '-',
}

// One trackable line, wherever it came from: its status (null: cancelled, not part of the plan), its text, the
// heading it sits under, how far it is indented, and the group a table column puts it in.
type Item = { indent: number; status: Status | null; text: string; head: number; group?: string }
type Head = { level: number; text: string }

// Strip the markdown a title doesn't need on a one-line pane: emphasis, code ticks, link targets.
export function cleanTitle(s: string): string {
  return clip(
    s
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, '')
      .replace(/\s+/g, ' '),
  )
}

// A group's name: the same, minus the parenthesised notes ("Phase 6 — documents (base = main 3a329ed, …)")
// that would push the progress bar off a narrow pane.
export function groupTitle(s: string): string {
  // Notes are cut before the title is clipped, so a long one cannot leave a bracket open.
  let out = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|`)/g, '')
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out.replace(/\s*\([^()]*\)/g, '')
  }
  out = out.replace(/\s*\([^)]*$/, '').replace(/\s+/g, ' ').trim()
  return out === '' ? cleanTitle(s) : clip(out)
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

function taskOf(n: number, text: string, status: Status, phase: string, phaseTitle: string, sub: string[]): Task {
  return { id: `f${n}`, subject: cleanTitle(text), active: '', status, phase, phaseTitle, sub, raw: true, startedAt: 0, doneAt: 0 }
}

// Checkbox lists, with the headings they sit under.
function collectCheckboxes(lines: readonly string[]): { heads: Head[]; items: Item[] } {
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
      heads.push({ level: (h[1] as string).length, text: groupTitle(h[2] as string) })
      continue
    }
    const b = BOX.exec(raw)
    const t = b ? null : TAG.exec(raw)
    const found = b ? { indent: b[1] as string, mark: b[2] as string, text: b[3] as string } : t ? { indent: t[1] as string, mark: TAG_MARK[(t[2] as string).replace(/️/g, '').toLowerCase()] ?? ' ', text: t[3] as string } : null
    if (found) items.push({ indent: width(found.indent), status: statusOfMark(found.mark), text: found.text, head: heads.length - 1 })
  }
  return { heads, items }
}

// How a file groups its work is read from the file: the headings above an item, the items it is nested under
// (a checkbox with checkboxes beneath it is a group, not a task: the GSD roadmap style), and a table's group
// column. Phase -> wave -> task, task -> sub-task, or anything else comes out as a path of group names.
function build(heads: readonly Head[], items: readonly Item[]): Task[] {
  if (items.length === 0) return []
  const isParent = items.map((it, i) => {
    const nxt = items[i + 1]
    return nxt !== undefined && nxt.head === it.head && nxt.indent > it.indent
  })
  // Headings that hold work of their own decide where the grouping starts: below the document's title, or at
  // the top level when the file only has one.
  const holders = new Set<number>()
  items.forEach((it, i) => {
    if (!isParent[i] && it.status !== null && it.head >= 0) holders.add(it.head)
  })
  const levels = [...holders].map(k => (heads[k] as Head).level)
  const floor = levels.length === 0 ? 0 : levels.some(l => l >= 2) ? 2 : Math.min(...levels)

  type Node = { id: string; title: string }
  const chainOf = (head: number): Node[] => {
    const chain: Node[] = []
    let level = Number.POSITIVE_INFINITY
    for (let k = head; k >= 0; k -= 1) {
      const h = heads[k] as Head
      if (h.level >= level) continue
      if (floor === 0 || h.level < floor) break
      chain.unshift({ id: `h${k}`, title: h.text })
      level = h.level
    }
    return chain
  }

  const order = new Map<string, string>()
  const keyFor = (id: string) => {
    let k = order.get(id)
    if (k === undefined) {
      k = String(order.size + 1).padStart(2, '0')
      order.set(id, k)
    }
    return k
  }

  const placed: { it: Item; path: Node[] }[] = []
  const stack: { indent: number; head: number; node: Node }[] = []
  items.forEach((it, i) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { indent: number; head: number }
      if (top.indent >= it.indent || top.head !== it.head) stack.pop()
      else break
    }
    if (isParent[i]) {
      stack.push({ indent: it.indent, head: it.head, node: { id: `c${i}`, title: groupTitle(it.text) } })
      return
    }
    if (it.status === null) return
    const path: Node[] = [...chainOf(it.head), ...stack.map(s => s.node)]
    if (it.group !== undefined) path.push({ id: `g${it.head}:${it.group}`, title: it.group })
    placed.push({ it, path })
  })
  // One group around everything ("## Plan" over the phases, "## Roadmap" over the phase checkboxes) says
  // nothing: the level below it is the phase.
  while (placed.length > 0 && placed.every(p => p.path.length > 1 && p.path[0]?.id === placed[0]?.path[0]?.id)) {
    for (const p of placed) p.path.shift()
  }
  return placed.slice(0, MAX_TASKS).map(({ it, path }, n) => {
    const top = path[0]
    return taskOf(n + 1, it.text, it.status as Status, top ? keyFor(top.id) : '', top ? top.title : '', path.slice(1, 1 + MAX_SUB).map(p => p.title))
  })
}

// What a status cell says, in whatever words the file uses. Checked in this order: cancelled, "not started",
// clearly under way, to do, finished, half-way words, and an unrecognised cell counts as not started.
const CANCELLED = /❌|✗|\b(?:cancel\w*|skipped|dropped|obsolete|abandoned)\b|won'?t do|iptal/i
const NOT_YET = /not (?:yet )?(?:started|done|begun|complete\w*)|başlamadı/i
const UNDER_WAY = /in[ -]?progress|\bwip\b|\bdoing\b|\bworking\b|\brunning\b|\bdispatched\b|\bunderway\b|\bongoing\b|🔄|⏳|🚧|🟡|devam|sürüyor|çalışılıyor|başlandı/i
const TO_DO = /⬜|☐|🔲|⏸|\bto ?do\b|\bpending\b|\bplanned\b|\bqueued\b|\bbacklog\b|bekliyor|yapılacak/i
const FINISHED = /✅|☑|✔|🟢|\b(?:done|complete[d]?|finished|shipped|merged|clean|closed|fixed|released|deployed)\b|bitti|tamam|kapandı/i
const HALF_WAY = /\bcommitted\b|\bstarted\b|\breview(?:ing)?\b|\bimplement\w*|\bbuilding\b|\bdraft\b/i

export function statusOfCell(cell: string): Status | null {
  if (CANCELLED.test(cell)) return null
  if (NOT_YET.test(cell)) return 'pending'
  if (UNDER_WAY.test(cell)) return 'in_progress'
  if (TO_DO.test(cell)) return 'pending'
  if (FINISHED.test(cell)) return 'completed'
  if (HALF_WAY.test(cell)) return 'in_progress'
  return 'pending'
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())

const STATUS_HEAD = /\b(?:status|state|durum)\b/i
const GROUP_HEAD = /^(?:wave|batch|stream|track|lane|group|dalga|grup)$/i
const TITLE_HEAD = /scope|description|summary|title|name|what|task|item|açıklama|kapsam|görev|konu/i
// A row that sums up a phase ("| **Phase 0** | gate … | CLOSED |") would count the phase twice.
const SUMMARY_ROW = /^(?:phase|faz|aşama|stage|part)\s*\d+\w*$/i
const TABLE_SEP = /^\s*\|?[\s:|-]+\|?\s*$/

type Cols = { id: number; title: number; status: number; group: number; groupName: string }

// Status tables: a row is a task, the Status column says how it stands, a Wave/Group column nests it one level
// down. Used only when the file has no checkboxes, and only for a table with a Status/Durum column, to avoid
// reading unrelated tables.
function collectTables(lines: readonly string[]): { heads: Head[]; items: Item[] } {
  const heads: Head[] = []
  const items: Item[] = []
  let cols: Cols | null = null
  let fenced = false
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced
    if (fenced) continue
    const h = HEAD.exec(raw)
    if (h) {
      heads.push({ level: (h[1] as string).length, text: groupTitle(h[2] as string) })
      cols = null
      continue
    }
    if (!raw.trim().startsWith('|')) {
      cols = null
      continue
    }
    const row = cells(raw)
    if (cols === null) {
      const status = row.findIndex(c => STATUS_HEAD.test(c))
      if (status >= 0 && TABLE_SEP.test((lines[i + 1] as string | undefined) ?? '')) {
        const group = row.findIndex((c, k) => k !== status && GROUP_HEAD.test(c))
        const id = row.findIndex((_, k) => k !== status && k !== group)
        let title = row.findIndex((c, k) => k !== id && k !== status && k !== group && TITLE_HEAD.test(c))
        if (title < 0) title = row.findIndex((_, k) => k !== id && k !== status && k !== group)
        cols = { id, title, status, group, groupName: group >= 0 ? (row[group] as string) : '' }
      }
      continue
    }
    if (/^[\s:-]+$/.test(row.join(''))) continue
    const id = cleanTitle(row[cols.id] ?? '')
    if (id === '' || SUMMARY_ROW.test(id)) continue
    const status = statusOfCell(row[cols.status] ?? '')
    if (status === null) continue
    const title = cols.title >= 0 ? cleanTitle(row[cols.title] ?? '') : ''
    const value = cols.group >= 0 ? cleanTitle(row[cols.group] ?? '') : ''
    // "Wave" + "A" reads "Wave A"; a value that says something by itself stays as it is.
    const group = /^[—–-]?$/.test(value) ? undefined : value.length <= 3 ? `${cols.groupName} ${value}` : value
    items.push({ indent: 0, status, text: title === '' || title === '—' ? id : `${id} · ${title}`, head: heads.length - 1, group })
  }
  return { heads, items }
}

export function parsePlan(markdown: string): Task[] {
  const lines = markdown.split(/\r?\n/)
  const boxes = collectCheckboxes(lines)
  const fromBoxes = build(boxes.heads, boxes.items)
  if (fromBoxes.length > 0) return fromBoxes
  const table = collectTables(lines)
  return build(table.heads, table.items)
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
