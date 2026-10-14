import { describe, expect, mock, test } from 'claude-code/testing'
import { PANE, run, start, world } from './helpers.js'

describe('is-it-done-yet', () => {
  test('tracks created and updated tasks and draws percent, counts and the current task', async ($, on) => {
    world(on)
    for (const subject of ['Phase 1: schema', 'Phase 1: api', 'Faz 2 - ui', 'ship it']) {
      await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
    }
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Writing the api' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface })
      expect(await pane.find({ type: 'Text', text: /^25%$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /1\/4/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /▶ Writing the api/ })).toBeDefined()
      await pane.unmount()
    }
  })

  test('phases are an accordion: the active one is open, a press opens another', async ($, on) => {
    world(on)
    for (const subject of ['Phase 1: schema', 'Phase 1: api', 'Faz 2 - ui']) {
      await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
    }
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /○ schema/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /○ ui/ })).toBeUndefined()
    await pane.press({ key: 'phase-2' })
    expect(await pane.find({ type: 'Text', text: /○ ui/ })).toBeDefined()
    await pane.press({ key: 'phase-1' })
    expect(await pane.find({ type: 'Text', text: /○ schema/ })).toBeUndefined()
  })

  test('TodoWrite replaces the list; a deleted task leaves it', async ($, on) => {
    world(on)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'one', status: 'completed', activeForm: 'Doing one' },
        { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
      ],
    })
    let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
    await pane.unmount()
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'one', status: 'completed', activeForm: 'Doing one' }] })
    pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /^100%$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /done ✓/ })).toBeDefined()
  })

  test('tokens add up over turns and the cost is the session ledger', async ($, on) => {
    world(on, 1.5)
    on('turn.complete', () => ({ text: '' }))
    const turn = {
      turnId: 't1',
      reason: 'answer' as const,
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      usage: { input_tokens: 500_000, output_tokens: 100_000, cache_read_input_tokens: 1_800_000, cache_creation_input_tokens: 100_000, model: 'm' },
    }
    await $.turn.complete(turn)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /2\.5M/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /\$1\.50/ })).toBeDefined()
  })

  test('the task hooks add nothing for the model to read', async ($, on) => {
    world(on)
    const r = await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
    expect(r).toEqual({ result: { task: { id: '1', subject: 'a' } } })
  })

  test('the first task opens the pane once; /progress closes and reopens it', async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'b', description: 'b' })
    expect(w.opened).toBe(1)
    await $.command.run(run(''))
    expect([w.closed, w.open]).toEqual([1, false])
    await $.command.run(run(''))
    expect([w.opened, w.open]).toEqual([2, true])
  })

  test('autoOpen off: the first task opens nothing', { options: { autoOpen: false } }, async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
    expect(w.opened).toBe(0)
  })

  test('/progress goal sets the title; reset clears the list', async ($, on) => {
    world(on)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
    await $.command.run(run('goal Ship the thing'))
    let pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /◆ Ship the thing/ })).toBeDefined()
    await pane.unmount()
    await $.command.run(run('reset'))
    pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /No plan file found/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /◆ demo/ })).toBeDefined()
  })

  test('the saved plan comes back after /clear, /resume and /branch', async ($, on) => {
    world(on, 0, {
      's-sess-1': {
        tasks: [
          { id: '1', subject: 'Phase 1: kept', active: '', status: 'completed', phase: '1', startedAt: 10, doneAt: 20 },
          { id: '2', subject: 'Phase 1: also kept', active: '', status: 'pending', phase: '1', startedAt: 0, doneAt: 0 },
        ],
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        costUsd: 2,
        goal: 'Saved goal',
        startedAt: 5,
      },
    })
    on('classic.SessionStart', () => ({}))
    await $.classic.SessionStart({ source: 'clear' })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /◆ Saved goal/ })).toBeDefined()
  })

  test('the redraw timer asks about the pane every 30 s, and a closed pane draws nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(start)
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
    const before = w.panesAsked
    await w.clock.advance(30_000)
    expect(w.panesAsked).toBe(before + 1)
    await $.command.run(run('close'))
    await w.clock.advance(30_000)
    expect(w.panesAsked).toBe(before + 2)
  })
})
