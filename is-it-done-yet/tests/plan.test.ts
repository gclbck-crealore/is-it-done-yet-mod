import { describe, expect, test } from 'claude-code/testing'
import { groups, isOpen, pickSource, stats, type Task } from '../hooks/model.js'
import { parsePlan, rebuildFromTranscript, scorePlan } from '../hooks/plan.js'
import { PANE, project, run, start, world, type PlanFile } from './helpers.js'

const PLAN = `# Project

## Phase 1: Setup
- [x] Init repo
- [x] CI
- [ ] Docs

## Phase 2: API
- [~] Auth module
- [ ] Endpoints
- [-] Dropped idea

\`\`\`
- [ ] not a task
\`\`\`
`

const ROADMAP = `## Roadmap
- [x] **Phase 1: Foundation** - base
  - [x] 01-01 Scaffold
  - [x] 01-02 Schema
- [ ] **Phase 2: Core**
  - [ ] 02-01 Auth
  - [~] 02-02 API
`

const TABLE = `## Status
| Phase | Status |
|---|---|
| Setup | ✅ Done |
| API | 🔄 In progress |
| UI | ⬜ Todo |
| Old | ❌ Cancelled |
`


// A board as an orchestrating agent keeps it: a table per phase, free-text statuses, a wave column in some,
// a row that sums the phase up.
const BOARD = `# BOARD — task board

## Phase 0 — skeleton (start SHA e26e20f)
| Task | Scope | Status |
|---|---|---|
| p0-t1 | scaffold, lint | CLEAN r3, merged 3c70f1b |
| p0-t2 | core, ports | CLEAN r8, merged 734430d |
| **Phase 0** | gate: verify:all 8/8 | **CLOSED** |
| docs | FLOW_MAP, DECISIONS | done (b666f8e) |

## Phase 2 — staff panel (base = p1 ae474dc; merges after Phase 1 closes)
| Task | Scope | Status |
|---|---|---|
| p2-t1 | staff SSO | CLEAN r16 (1fdd998); merge after Phase 1 closes |
| p2-t2 | admin screens | committed 189e028 (verify:all PASS); review r1 running |
| p2-t3 | assignment | not started |

## Phase 3 — inbound mail
| Task | Wave | Scope | Status |
|---|---|---|---|
| p3-t1 | A | providers | **CLEAN** r11 → merged |
| p3-t2 | A | mail adapter | CLOSED at e743a1f |
| p3-t3 | B | intake decisions | dispatched (BASE b69fc6f) |
| p3-t4 | B | outbound core | planned |
| p3-t5 | — | scenario | skipped |

## Later phases
- P4: adapters
`

const files = (entries: Record<string, PlanFile>) => new Map(Object.entries(entries))

const task = (status: Task['status'], doneAt = 0): Task => ({ id: 'x', subject: 'x', active: '', status, phase: '', phaseTitle: '', startedAt: 0, doneAt })

describe('parsePlan', () => {
  test('headings become phases; [~] is in progress, [-] is dropped, fenced code is ignored', () => {
    expect(parsePlan(PLAN).map(t => [t.subject, t.status, t.phase, t.phaseTitle])).toEqual([
      ['Init repo', 'completed', '01', 'Phase 1: Setup'],
      ['CI', 'completed', '01', 'Phase 1: Setup'],
      ['Docs', 'pending', '01', 'Phase 1: Setup'],
      ['Auth module', 'in_progress', '02', 'Phase 2: API'],
      ['Endpoints', 'pending', '02', 'Phase 2: API'],
    ])
  })

  test('a checkbox with checkboxes under it is a phase, not a task', () => {
    expect(parsePlan(ROADMAP).map(t => [t.subject, t.status, t.phaseTitle])).toEqual([
      ['01-01 Scaffold', 'completed', 'Phase 1: Foundation - base'],
      ['01-02 Schema', 'completed', 'Phase 1: Foundation - base'],
      ['02-01 Auth', 'pending', 'Phase 2: Core'],
      ['02-02 API', 'in_progress', 'Phase 2: Core'],
    ])
  })

  test('a status table is read only when the file has no checkboxes', () => {
    expect(parsePlan(TABLE).map(t => [t.subject, t.status, t.phaseTitle])).toEqual([
      ['Setup', 'completed', 'Status'],
      ['API', 'in_progress', 'Status'],
      ['UI', 'pending', 'Status'],
    ])
    expect(parsePlan(`${PLAN}\n${TABLE}`).length).toBe(5)
  })

  test('prose with no checkbox and no status table is not a plan', () => {
    expect(parsePlan('# Notes\n\nSome words.\n- a bullet\n')).toEqual([])
  })
})

describe('plan tables written by an agent', () => {
  test('free-text statuses are read, a phase summary row is not a task, the id stays whole', () => {
    expect(parsePlan(BOARD).map(t => [t.subject, t.status, t.phaseTitle])).toEqual([
      ['p0-t1 · scaffold, lint', 'completed', 'Phase 0 — skeleton'],
      ['p0-t2 · core, ports', 'completed', 'Phase 0 — skeleton'],
      ['docs · FLOW_MAP, DECISIONS', 'completed', 'Phase 0 — skeleton'],
      ['p2-t1 · staff SSO', 'completed', 'Phase 2 — staff panel'],
      ['p2-t2 · admin screens', 'in_progress', 'Phase 2 — staff panel'],
      ['p2-t3 · assignment', 'pending', 'Phase 2 — staff panel'],
      ['p3-t1 · providers', 'completed', 'Phase 3 — inbound mail'],
      ['p3-t2 · mail adapter', 'completed', 'Phase 3 — inbound mail'],
      ['p3-t3 · intake decisions', 'in_progress', 'Phase 3 — inbound mail'],
      ['p3-t4 · outbound core', 'pending', 'Phase 3 — inbound mail'],
    ])
  })

  test('a Wave column nests tasks one level below their phase, each level with its own count', () => {
    const tree = groups(parsePlan(BOARD))
    expect(tree.map(g => [g.label, g.done, g.tasks.length])).toEqual([
      ['Phase 0 — skeleton', 3, 3],
      ['Phase 2 — staff panel', 1, 3],
      ['Phase 3 — inbound mail', 2, 4],
    ])
    const p3 = tree[2]
    expect(p3?.children.map(g => [g.label, g.done, g.active, g.tasks.length])).toEqual([
      ['Wave A', 2, 0, 2],
      ['Wave B', 0, 1, 2],
    ])
    expect(p3?.direct).toEqual([])
  })

  test('a finished phase is folded to its bar; phases with work under way and their unfinished waves are open', () => {
    const tree = groups(parsePlan(BOARD))
    expect(tree.map(g => isOpen(g, tree, 1, {}))).toEqual([false, true, true])
    const waves = tree[2]?.children ?? []
    expect(waves.map(g => isOpen(g, waves, 2, {}))).toEqual([false, true])
    expect(isOpen(tree[0] as never, tree, 1, { [tree[0]?.key ?? '']: true })).toBe(true)
  })

  test('parenthesised notes in a heading do not reach the phase name', () => {
    expect(parsePlan(BOARD).every(t => !t.phaseTitle.includes('('))).toBe(true)
  })

  test('headings below a phase and nested checkboxes nest the same way', () => {
    const doc = `# Plan\n\n## Phase 1\n### Backend\n- [x] API\n- [ ] Auth\n  - [x] login\n  - [ ] logout\n### UI\n- [ ] Shell\n\n## Phase 2\n- [ ] Ship\n`
    const tasks = parsePlan(doc)
    expect(tasks.map(t => [t.subject, t.phaseTitle, t.sub])).toEqual([
      ['API', 'Phase 1', ['Backend']],
      ['login', 'Phase 1', ['Backend', 'Auth']],
      ['logout', 'Phase 1', ['Backend', 'Auth']],
      ['Shell', 'Phase 1', ['UI']],
      ['Ship', 'Phase 2', []],
    ])
    const p1 = groups(tasks)[0]
    expect(p1?.children.map(g => [g.label, g.tasks.length, g.children.map(c => c.label)])).toEqual([
      ['Backend', 3, ['Auth']],
      ['UI', 1, []],
    ])
  })

  test('one heading around every phase is not a group of its own', () => {
    const doc = '# T\n## Plan\n### Phase 1\n- [x] a\n### Phase 2\n- [ ] b\n'
    expect(parsePlan(doc).map(t => [t.subject, t.phaseTitle, t.sub])).toEqual([
      ['a', 'Phase 1', []],
      ['b', 'Phase 2', []],
    ])
  })

  test('a plan task named like a phase prefix keeps its text', () => {
    const tasks = parsePlan(BOARD)
    const t = tasks.find(x => x.subject.startsWith('p2-t1'))
    expect(t?.raw).toBe(true)
    expect(stats(tasks, 0, 0).current).toBe('p2-t2 · admin screens')
  })
})

describe('rebuildFromTranscript and stats', () => {
  test('replays the task tools in order and skips failed calls', () => {
    const tasks = rebuildFromTranscript([
      { toolUses: [{ tool: 'TaskCreate', input: { subject: 'Phase 1: a' }, result: { task: { id: '1', subject: 'Phase 1: a' } } }] },
      {
        toolUses: [
          { tool: 'TaskCreate', input: { subject: 'Phase 1: b' }, result: { task: { id: '2', subject: 'Phase 1: b' } } },
          { tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: { success: true } },
        ],
      },
      { toolUses: [{ tool: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' }, result: { success: false } }] },
    ])
    expect(tasks.map(t => [t.id, t.status, t.phase])).toEqual([
      ['1', 'completed', '1'],
      ['2', 'pending', '1'],
    ])
  })

  test('the plan wins by default, a mode with nothing to show falls back', () => {
    expect([pickSource('auto', 3, 2), pickSource('auto', 0, 2), pickSource('live', 3, 2), pickSource('live', 3, 0), pickSource('plan', 0, 2)]).toEqual([
      'plan',
      'live',
      'live',
      'plan',
      'live',
    ])
  })

  test('the ETA counts only what this session finished', () => {
    const tasks = [...Array(6).fill(0).map(() => task('completed')), ...Array(4).fill(0).map(() => task('pending'))]
    const hour = 3_600_000
    expect(stats(tasks, 1000, 1000 + hour, 6).etaMs).toBeNull()
    expect(stats(tasks, 1000, 1000 + hour, 4).etaMs).toBe((hour / 2) * 4)
    expect(stats(tasks, 1000, 1000 + hour, 0).etaMs).toBe((hour / 6) * 4)
  })
})

describe('which file is the plan', () => {
  test('status written as a symbol or a tag counts like a checkbox', () => {
    expect(parsePlan('- ✅ shipped\n- 🔄 building\n- ⬜ later\n1. [DONE] tagged\n- ❌ dropped\n').map(t => [t.subject, t.status])).toEqual([
      ['shipped', 'completed'],
      ['building', 'in_progress'],
      ['later', 'pending'],
      ['tagged', 'completed'],
    ])
  })

  test('the title and first lines decide, not the name or the size', () => {
    const tasks = parsePlan('- [x] a\n- [ ] b\n- [ ] c\n')
    const bigTasks = parsePlan(Array.from({ length: 12 }, (_, i) => `- [ ] item ${i}`).join('\n'))
    const plan = scorePlan('# Launch plan\nProgress tracker for the launch.\n\n- [x] a\n- [ ] b\n- [ ] c\n', tasks, 0, 0)
    const review = scorePlan('# Code review notes\nFindings to look at.\n\n' + Array.from({ length: 12 }, (_, i) => `- [ ] item ${i}`).join('\n'), bigTasks, 0, 0)
    expect(plan.score).toBeGreaterThan(review.score)
    expect(plan.title).toBe('Launch plan')
  })

  test('Turkish titles read as a plan too', () => {
    const tasks = parsePlan('- [x] a\n- [ ] b\n')
    expect(scorePlan('# Yapılacaklar\nİlerleme durumu\n- [x] a\n- [ ] b\n', tasks, 0, 0).score).toBeGreaterThan(scorePlan('# Misc\nthings\n- [x] a\n- [ ] b\n', tasks, 0, 0).score)
  })

  test('a newer file ranks above an older one with the same content', () => {
    const md = '# Plan\n- [x] a\n- [ ] b\n'
    const tasks = parsePlan(md)
    const day = 86_400_000
    expect(scorePlan(md, tasks, 10 * day, 10 * day).score).toBeGreaterThan(scorePlan(md, tasks, 0, 10 * day).score)
  })
})

describe('the project plan in the pane', () => {
  const pane = (surface: 'terminal' | 'desktop' = 'terminal') => ({ ...PANE, surface })
  const TRACKER = '# Launch checklist\nProgress tracker for the launch.\n\n## Phase 1\n- [x] a\n- [ ] b\n- [ ] c\n'
  const NOTES = '# Architecture overview\nHow the system fits together.\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n'

  test('a plan file is shown as soon as the session starts, whatever it is called', async ($, on) => {
    world(on)
    project(on, files({ 'zeta.md': { text: PLAN, mtimeMs: 10 } }))
    await $.session.start(start)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: /^40%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /≡ zeta\.md · 5 tasks/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'phase-02' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /▶ Auth module/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('every phase shows its bar and count, finished ones folded; waves and tasks show inside the open ones', async ($, on) => {
    world(on)
    project(on, files({ 'board.md': { text: BOARD, mtimeMs: 10 } }))
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    for (const key of ['phase-01', 'phase-02', 'phase-03', 'phase-03/Wave A', 'phase-03/Wave B']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    for (const count of [/^3\/3$/, /^1\/3$/, /^2\/4$/]) expect(await ui.find({ type: 'Text', text: count })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: /✓ Phase 0 — skeleton$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /p0-t1/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /● p2-t2 · admin screens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /○ p3-t4 · outbound core/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ p2-t2 · admin screens/ })).toBeDefined()
  })

  test('among several markdown files the one that reads like a tracker is followed', async ($, on) => {
    world(on)
    project(on, files({ 'a-notes.md': { text: NOTES, mtimeMs: 10 }, 'b-doc.md': { text: TRACKER, mtimeMs: 10 }, 'c-readme.md': { text: '# Hello\n\nNo list here.\n', mtimeMs: 10 } }))
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /≡ b-doc\.md · 3 tasks/ })).toBeDefined()
  })

  test('same list, newer file: the one whose title says plan wins over one titled architecture', async ($, on) => {
    world(on)
    const body = '- [x] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n- [ ] f\n'
    project(on, files({ 'older.md': { text: `# Project plan\n\n${body}`, mtimeMs: 10 }, 'newer.md': { text: `# Architecture overview\n\n${body}`, mtimeMs: 20 } }))
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /≡ older\.md · 6 tasks/ })).toBeDefined()
  })

  test('files in folders are found, dependencies and one-item lists are not', async ($, on) => {
    world(on)
    project(
      on,
      files({
        'docs/deep/roadmap-x.md': { text: '# Roadmap\n- [x] a\n- [ ] b\n', mtimeMs: 7 },
        'node_modules/pkg/README.md': { text: '# Plan\nProgress\n' + Array.from({ length: 20 }, (_, i) => `- [ ] t${i}`).join('\n'), mtimeMs: 99 },
        'lonely.md': { text: '# Plan\n- [ ] only\n', mtimeMs: 99 },
      }),
    )
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /≡ docs\/deep\/roadmap-x\.md · 2 tasks/ })).toBeDefined()
  })

  test('a plan that is a link out of the project folder is not read', async ($, on) => {
    world(on)
    project(on, files({ 'x.md': { text: PLAN, mtimeMs: 10, real: '/etc/x.md' } }))
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /No plan or task list found/ })).toBeDefined()
  })

  test('a file larger than the size limit is skipped', async ($, on) => {
    world(on)
    project(on, files({ 'big.md': { text: `# Plan\n${'- [ ] item\n'.repeat(40_000)}`, mtimeMs: 10 }, 'small.md': { text: TRACKER, mtimeMs: 5 } }))
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /≡ small\.md/ })).toBeDefined()
  })

  test('ticking a box in the file shows up after the next turn', async ($, on) => {
    world(on)
    const f = files({ 'work.md': { text: PLAN, mtimeMs: 10 } })
    project(on, f)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(start)
    f.set('work.md', { text: PLAN.replace('- [~] Auth module', '- [x] Auth module'), mtimeMs: 20 })
    await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false })
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /^60%$/ })).toBeDefined()
  })

  test('/progress plan lists what was found; with a file it follows it and refuses a path outside the project', async ($, on) => {
    world(on)
    project(
      on,
      files({
        'a.md': { text: TRACKER, mtimeMs: 10 },
        'docs/mine.md': { text: '- [x] a\n- [ ] b\n', mtimeMs: 1 },
        'secret.md': { text: '- [ ] x\n- [ ] y\n', mtimeMs: 1, real: '/etc/secret.md' },
        'notes.md': { text: 'just prose', mtimeMs: 1 },
      }),
    )
    await $.session.start(start)
    const listed = (await $.command.run(run('plan'))).text ?? ''
    expect(listed).toMatch(/1\. a\.md: 1\/3 done, "Launch checklist"/)
    expect(listed).toMatch(/2\. docs\/mine\.md/)
    expect((await $.command.run(run('plan docs/mine.md'))).text).toBe('following docs/mine.md (2 tasks)')
    expect((await $.command.run(run('plan ../secret.md'))).text).toMatch(/not a readable file inside this project/)
    expect((await $.command.run(run('plan notes.md'))).text).toMatch(/no checkbox items/)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /≡ docs\/mine\.md · 2 tasks/ })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(run('plan auto'))).text).toMatch(/on its own again/)
    const again = await $.ui.mount(pane())
    expect(await again.find({ type: 'Text', text: /≡ a\.md · 3 tasks/ })).toBeDefined()
  })

  test('the button walks through the candidates, then the session tasks, then round', async ($, on) => {
    world(on)
    project(on, files({ 'a.md': { text: TRACKER, mtimeMs: 10 }, 'b.md': { text: '# Todo\n- [x] a\n- [ ] b\n', mtimeMs: 10 } }))
    await $.session.start(start)
    await $.tool.call({ tool: 'TaskCreate', subject: 'Phase 1: only task', description: 'x' })
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /≡ a\.md · 3 tasks/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /b\.md \(2\)/ })).toBeDefined()
    await ui.press({ key: 'switch' })
    expect(await ui.find({ type: 'Text', text: /≡ b\.md · 2 tasks/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Session tasks \(1\)/ })).toBeDefined()
    await ui.press({ key: 'switch' })
    expect(await ui.find({ type: 'Text', text: /⚙ Session tasks · 1 task/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /a\.md \(3\)/ })).toBeDefined()
  })

  test('a mod loaded mid-session rebuilds the task list from the transcript', async ($, on) => {
    world(on)
    project(on, files({}))
    on('session.messages', () => ({
      value: [
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'TaskCreate', input: { subject: 'Phase 1: a' }, result: { task: { id: '1', subject: 'Phase 1: a' } } }] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'TaskCreate', input: { subject: 'Phase 1: b' }, result: { task: { id: '2', subject: 'Phase 1: b' } } }] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c', tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: { success: true } }] },
      ] as never,
    }))
    await $.session.start(start)
    const ui = await $.ui.mount(pane())
    expect(await ui.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⚙ Session tasks · 2 tasks/ })).toBeDefined()
  })

  test('a project with a plan opens the pane at startup; autoOpen off does not', async ($, on) => {
    const w = world(on)
    project(on, files({ 'x.md': { text: PLAN, mtimeMs: 10 } }))
    await $.session.start(start)
    expect(w.opened).toBe(1)
  })

  test('autoOpen off: no pane at startup even with a plan', { options: { autoOpen: false } }, async ($, on) => {
    const w = world(on)
    project(on, files({ 'x.md': { text: PLAN, mtimeMs: 10 } }))
    await $.session.start(start)
    expect(w.opened).toBe(0)
  })

  test('without any plan nothing opens by itself', async ($, on) => {
    const w = world(on)
    project(on, files({ 'readme.md': { text: '# Hi\n\nNothing to track.\n', mtimeMs: 1 } }))
    await $.session.start(start)
    expect(w.opened).toBe(0)
  })

  test('pinning a plan opens the pane', { options: { autoOpen: false } }, async ($, on) => {
    const w = world(on)
    project(on, files({ 'docs/mine.md': { text: '- [x] a\n- [ ] b\n', mtimeMs: 1 } }))
    await $.session.start(start)
    expect(w.opened).toBe(0)
    await $.command.run(run('plan docs/mine.md'))
    expect(w.opened).toBe(1)
  })
})
