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

// A project folder in memory: `files` is what fs.stat, fs.read and fs.list answer from. The engine hands the
// stubs absolute paths, so a file is matched by the end of the path; a path that matches nothing is the folder itself.
export function project(on: On, files: Map<string, PlanFile>, dirs: Record<string, string[]> = {}) {
  const byEnd = <T>(path: string, keys: Iterable<string>, pick: (key: string) => T): T | undefined => {
    const hit = [...keys].sort((a, b) => b.length - a.length).find(k => path === k || path.endsWith(`/${k}`))
    return hit === undefined ? undefined : pick(hit)
  }
  on('fs.stat', ($, e) => {
    const key = byEnd(e.path, files.keys(), k => k)
    const f = key === undefined ? undefined : files.get(key)
    if (!f) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: '/proj' } }
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false, realPath: f.real ?? `/proj/${key}` } }
  })
  on('fs.read', ($, e) => {
    const key = byEnd(e.path, files.keys(), k => k)
    const f = key === undefined ? undefined : files.get(key)
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', ($, e) => {
    const dir = byEnd(e.path, Object.keys(dirs), k => k)
    if (dir === undefined) return { deny: `ENOENT ${e.path}` }
    return {
      value: (dirs[dir] ?? []).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: files.get(`${dir}/${name}`)?.mtimeMs ?? 0, isLink: false })),
    }
  })
}
