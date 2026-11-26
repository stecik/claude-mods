export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
}

export type Place = { env: string; folder: string }

// Prompt cache hlavní smyčky: poslední request, který cache četl nebo zapsal,
// a součty tokenů vstupu za session (pro hit rate)
export type Cache = {
  at: number
  ttl: '5m' | '1h' | null
  read: number
  total: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      usage: Usage | null
      branch: string | null
      place: Place | null
      remote: boolean
      cost: number | null
      cache: Cache | null
    }
  }
}
