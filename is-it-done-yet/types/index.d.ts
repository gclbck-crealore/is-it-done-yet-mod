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
        startedAt: number
        doneAt: number
      }>
      planBase: number
      view: 'auto' | 'plan' | 'live'
      lastScan: number
    }
  }
}
