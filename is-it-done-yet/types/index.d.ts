declare module 'claude-code' {
  interface PluginState {
    'is-it-done-yet': {
      tasks: Array<{
        id: string
        subject: string
        active: string
        status: 'pending' | 'in_progress' | 'completed'
        phase: string
        phaseTitle: string
        sub?: string[]
        raw?: true
        startedAt: number
        doneAt: number
      }>
      tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
      costUsd: number
      goal: string
      startedAt: number
      expanded: Record<string, boolean>
      tick: number
      planPath: string
      planMtime: number
      planTasks: Array<{
        id: string
        subject: string
        active: string
        status: 'pending' | 'in_progress' | 'completed'
        phase: string
        phaseTitle: string
        sub?: string[]
        raw?: true
        startedAt: number
        doneAt: number
      }>
      planCands: Array<{ path: string; title: string; total: number; done: number; score: number }>
      planBase: number
      view: 'auto' | 'plan' | 'live'
      lastScan: number
    }
  }
}
