import { mock } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

export const PANE = {
  plugin: 'is-it-done-yet',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

export const start: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work/demo' }
export const run = (args: string): CommandRunInput => ({
  command: 'progress',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
})

export type World = { opened: number; closed: number; open: boolean; panesAsked: number; clock: ReturnType<typeof mock.clock> }

export function world(on: On, costUsd = 0, entries: Record<string, unknown> = {}): World {
  const w: World = { opened: 0, closed: 0, open: false, panesAsked: 0, clock: mock.clock(on, { now: 1_000_000 }) }
  mock.store(on, entries)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: costUsd } } }))
  on('ui.open', () => {
    w.opened += 1
    w.open = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    w.closed += 1
    w.open = false
    return { value: undefined }
  })
  on('ui.panes', () => {
    w.panesAsked += 1
    return { value: w.open ? [{ id: 'progress', title: 'Progress', isOpen: true } as never] : [] }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } as never }))
  let nextId = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => {
    nextId += 1
    return { result: { task: { id: String(nextId), subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))
  on('tool.call', { tool: 'TodoWrite' }, ($, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  return w
}


export type PlanFile = { text: string; mtimeMs: number; real?: string }

// A project folder in memory: `files` is what fs.list, fs.stat and fs.read answer from; folders come from the
// file names. The engine hands the stubs absolute paths, so a path is matched by its end, and one that matches
// no folder is the project root. A file with `real` set is a link: fs.list shows it as a link and fs.stat
// resolves it to that path.
export function project(on: On, files: Map<string, PlanFile>) {
  const parent = (k: string) => (k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '')
  const folders = () => {
    const set = new Set<string>()
    for (const k of files.keys()) {
      const parts = k.split('/')
      for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join('/'))
    }
    return set
  }
  const byEnd = (path: string, keys: Iterable<string>) => [...keys].sort((a, b) => b.length - a.length).find(k => path === k || path.endsWith(`/${k}`))
  on('fs.stat', ($, e) => {
    const key = byEnd(e.path, files.keys())
    const f = key === undefined ? undefined : files.get(key)
    if (!f) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: '/proj' } }
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false, realPath: f.real ?? `/proj/${key}` } }
  })
  on('fs.read', ($, e) => {
    const key = byEnd(e.path, files.keys())
    const f = key === undefined ? undefined : files.get(key)
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const all = folders()
    const dir = byEnd(e.path, all) ?? ''
    const entries = [
      ...[...files.entries()].filter(([k]) => parent(k) === dir).map(([k, f]) =>
        f.real === undefined
          ? { name: k.slice(dir === '' ? 0 : dir.length + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
          : { name: k.slice(dir === '' ? 0 : dir.length + 1), kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true },
      ),
      ...[...all].filter(d => parent(d) === dir).map(d => ({ name: d.slice(dir === '' ? 0 : dir.length + 1), kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
    ]
    return { value: entries }
  })
}
