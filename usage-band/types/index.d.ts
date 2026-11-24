export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
}

export type Place = { env: string; folder: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      usage: Usage | null
      branch: string | null
      place: Place | null
      remote: boolean
    }
  }
}
