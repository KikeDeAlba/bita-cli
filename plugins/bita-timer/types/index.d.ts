export type RunningTimer = {
  id: number
  title: string
  project: string | null
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'bita-timer': { timers: RunningTimer[]; now: number }
  }
}
