import type { Elements } from 'claude-code'
import {
  barCells,
  fmtDuration,
  fmtEta,
  fmtTokens,
  fmtUsd,
  groups,
  isOpen,
  stats,
  titleOf,
  totalTokens,
  type Task,
  type Tokens,
} from './model.js'

// Box, Text and Button exist on every surface, so the pane draws on all of them.
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type ViewData = {
  tasks: readonly Task[]
  tokens: Tokens
  costUsd: number
  goal: string
  startedAt: number
  expanded: Record<string, boolean>
  now: number
  columns: number
  // Where the list comes from: a plan file in the project, or the task tools of this session.
  source: 'plan' | 'live'
  sourceLabel: string
  other: { label: string; count: number } | null
  baseDone: number
}

export type ViewActions = {
  toggle: (key: string, open: boolean) => void
  close: () => void
  switchSource: () => void
}

const GREEN = '#3fb950'
const BLUE = '#4da3ff'
const GREY = '#6e7681'

const COLOR = { completed: GREEN, in_progress: BLUE, pending: GREY } as const
const ICON = { completed: '✓', in_progress: '●', pending: '○' } as const

export function renderPane(el: El, d: ViewData, act: ViewActions) {
  const { Box, Text, Button } = el
  const width = Math.max(8, Math.min(40, d.columns - 14))
  const s = stats(d.tasks, d.startedAt, d.now, d.baseDone)
  const all = groups(d.tasks)

  const bar = (done: number, active: number, total: number, w: number) => {
    const [g, b, r] = barCells(done, active, total, w)
    return (
      <Box flexDirection="row">
        {g > 0 ? <Text color={GREEN}>{'█'.repeat(g)}</Text> : null}
        {b > 0 ? <Text color={BLUE}>{'█'.repeat(b)}</Text> : null}
        {r > 0 ? <Text color={GREY}>{'░'.repeat(r)}</Text> : null}
      </Box>
    )
  }

  const stat = (label: string, value: string, note?: string) => (
    <Box flexDirection="row" gap={1}>
      <Text dimColor>{label.padEnd(7)}</Text>
      <Text bold>{value}</Text>
      {note ? <Text dimColor wrap="truncate-end">{note}</Text> : null}
    </Box>
  )

  const tk = d.tokens
  const eta = s.allDone ? 'done ✓' : s.etaMs === null ? '—' : fmtEta(s.etaMs)

  if (s.total === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold wrap="truncate-end">◆ {d.goal}</Text>
        <Text dimColor wrap="wrap">{"No plan or task list found in the markdown files of this folder, and the agent has not created tasks yet. See what was found, or follow one: /progress plan <file>"}</Text>
        {stat('Token', fmtTokens(totalTokens(tk)))}
        {stat('API', fmtUsd(d.costUsd))}
        <Button key="close" label="✕ Close" plain dimColor onPress={act.close} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">◆ {d.goal}</Text>
      <Text dimColor wrap="truncate-end">{d.source === 'plan' ? '≡' : '⚙'} {d.sourceLabel} · {s.total} {s.total === 1 ? 'task' : 'tasks'}</Text>
      {d.other ? <Button key="switch" label={`⇄ ${d.other.label} (${d.other.count})`} plain dimColor onPress={act.switchSource} /> : null}
      <Box flexDirection="row" gap={1}>
        {bar(s.done, s.active, s.total, width)}
        <Text bold>{s.pct}%</Text>
        <Text dimColor>{s.done}/{s.total}</Text>
      </Box>
      <Box flexDirection="row" gap={2}>
        <Text color={GREEN}>✓ {s.done}</Text>
        <Text color={BLUE}>● {s.active}</Text>
        <Text color={GREY}>○ {s.todo}</Text>
      </Box>
      {s.current ? <Text color={BLUE} wrap="truncate-end">▶ {s.current}</Text> : null}
      {!s.current && s.next && !s.allDone ? <Text color={GREY} wrap="truncate-end">→ Next: {s.next}</Text> : null}
      <Text> </Text>
      {stat(d.source === 'plan' ? 'Session' : 'Elapsed', fmtDuration(s.elapsedMs))}
      {stat('Left', eta, s.allDone || s.etaMs === null ? undefined : 'rough guess')}
      {stat('Token', fmtTokens(totalTokens(tk)), `out ${fmtTokens(tk.output)}`)}
      {stat('API', fmtUsd(d.costUsd), 'at API prices')}
      <Text> </Text>
      {all.map(g => {
        const open = isOpen(g, all, d.expanded)
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key={`phase-${g.key}`} label={`${open ? '▾' : '▸'} ${g.label}`} plain onPress={() => act.toggle(g.key, !open)} />
              {bar(g.done, g.active, g.tasks.length, 8)}
              <Text dimColor>{g.done}/{g.tasks.length}</Text>
            </Box>
            {open
              ? g.tasks.map(t => (
                  <Box paddingLeft={2}>
                    <Text color={COLOR[t.status]} bold={t.status === 'in_progress'} wrap="truncate-end">
                      {ICON[t.status]} {titleOf(t.subject)}
                    </Text>
                  </Box>
                ))
              : null}
          </Box>
        )
      })}
      <Text> </Text>
      <Button key="close" label="✕ Close" plain dimColor onPress={act.close} />
    </Box>
  )
}
