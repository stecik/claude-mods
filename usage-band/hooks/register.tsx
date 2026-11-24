import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Usage } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const branch = atom({ plugin: 'usage-band', key: 'branch' } as const, null)

// Aktuální větev pracovní kopie; null mimo repozitář nebo při detached HEAD
const refreshBranch = async ($: EngineInterface): Promise<void> => {
  let name: string | null = null
  try {
    name = (await $.vcs.detect({ path: '.' }))?.branch ?? null
  } catch {
    name = null
  }
  await update($, branch, () => name)
}

const place = atom({ plugin: 'usage-band', key: 'place' } as const, null)
const remote = atom({ plugin: 'usage-band', key: 'remote' } as const, false)

// Prostředí (local / ssh <host>) a název složky projektu
const refreshPlace = async ($: EngineInterface): Promise<void> => {
  const root = await $.session.root()
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  const isSsh = (await $.env.get('SSH_CONNECTION')) !== undefined
  const host = (await $.env.get('HOSTNAME')) ?? (await $.env.get('COMPUTERNAME')) ?? 'remote'
  const env = isSsh ? `ssh ${host}` : 'local'
  await update($, place, () => ({ env, folder }))
}

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const toLimits = (limits: SessionRateLimit[]): Limit[] =>
  limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))

// Limity platí pro účet, ne pro session: poslední známé se drží v $.store,
// aby byly vidět i v nové session před první odpovědí API
const resolveLimits = async ($: EngineInterface, live: SessionRateLimit[]): Promise<Limit[]> => {
  if (live.length > 0) {
    const limits = toLimits(live)
    await $.store.set('limits', limits)
    return limits
  }
  const cached = (await $.store.get('limits')) as Limit[] | undefined
  if (!Array.isArray(cached)) return []
  const now = await $.clock.now()
  return cached.filter(l => !l.resetsAt || Date.parse(l.resetsAt) > now)
}

const toUsage = async (
  $: EngineInterface,
  context: SessionContextUsage,
  live: SessionRateLimit[],
): Promise<Usage> => ({
  tokens: context.tokens,
  window: context.window,
  percent: context.percent,
  limits: await resolveLimits($, live),
})

const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

// Barvy jako panel limitů v aplikaci: modrá, od 70 % žlutá, od 90 % červená
const BLUE = '#2f7de1'
const TRACK = '#4a4a4a'

const levelColor = (percent: number): string =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : BLUE

// Čas do resetu jako " 2h 15m" / " 3d 4h"
const untilReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return ` ${days}d ${hours}h`
  if (hours > 0) return ` ${hours}h ${minutes % 60}m`
  return ` ${minutes}m`
}

const clampPercent = (percent: number): number => Math.max(0, Math.min(100, Math.round(percent)))

type Item = { key: string; label: string; percent: number; text: string }

// Desktop kreslí SessionMode jako jeden řádek textu (bez Svg a mezer mezi Boxy),
// proto ikony jako emoji
const ICONS = { local: '💻', ssh: '🖧', folder: '📁', branch: '🌿', remote: '📱' }

// Připojení klienti; víc než jeden = Remote Control (telefon nebo web) je připojený
const clients = new Set<string>()

const refreshRemote = async ($: EngineInterface): Promise<void> => {
  const surfaces = await $.session.surfaces()
  const isRemote = clients.size > 1 || surfaces.length > 1
  await update($, remote, () => isRemote)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const current = await $.session.usage()
    const value = await toUsage($, current.context, current.rateLimits)
    await update($, usage, () => value)
    await refreshBranch($)
    await refreshPlace($)
    await refreshRemote($)
    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    clients.add(e.clientId)
    await refreshRemote($)
    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    clients.delete(e.clientId)
    await refreshRemote($)
    return result
  })

  // Větev se může změnit během turnu (git checkout) nebo ručně mezi turny
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshBranch($)
    return result
  })

  // Neblokuje odeslání promptu; /cd může změnit složku
  on('prompt.submit', ($, e, next) => {
    refreshBranch($).catch(() => undefined)
    refreshPlace($).catch(() => undefined)
    return next(e)
  })

  // Patička pod promptem: prostředí, složka, větev, Remote Control.
  // Desktop kreslí jen SessionMode (PromptHint ne), proto vlastní strom tady
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const name = await read($, branch)
    const where = await read($, place)
    const isRemote = await read($, remote)
    const parts = [
      ...(where
        ? [
            where.env === 'local' ? ICONS.local : `${ICONS.ssh} ${where.env.replace(/^ssh /, '')}`,
            `${ICONS.folder} ${where.folder}`,
          ]
        : []),
      ...(name !== null ? [`${ICONS.branch} ${name}`] : []),
      ...(isRemote ? [ICONS.remote] : []),
    ]
    if (parts.length === 0) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{parts.join('  ')}</Text>
  })

  // Engine posílá změny sám, není třeba pollovat
  on('session.measure', async ($, e, next) => {
    const value = await toUsage($, e.context, e.rateLimits)
    await update($, usage, () => value)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const value = await read($, usage)
    if (e.props.hasSurvey || value === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const percent = value.percent ?? 0
    const items: Item[] = [
      {
        key: 'ctx',
        label: 'ctx',
        percent,
        text:
          value.tokens === undefined
            ? `— / ${kTokens(value.window)}`
            : `${percent}% ${kTokens(value.tokens)}/${kTokens(value.window)}`,
      },
      ...value.limits.map(l => ({
        key: l.kind,
        label: LABELS[l.kind] ?? l.kind,
        percent: l.percentUsed,
        text: `${Math.round(l.percentUsed)}%${untilReset(l.resetsAt, now)}`,
      })),
    ]

    // Každá položka dostane stejný díl šířky, pruh vyplní zbytek
    return (
      <Box flexDirection="row" width="100%" alignItems="center" gap={3}>
        {items.map(item => (
          <Box key={item.key} flexDirection="row" flexGrow={1} flexShrink={1} alignItems="center" gap={1}>
            <Text dimColor>{item.label}</Text>
            <Box flexGrow={1} height={1} minWidth={6} backgroundColor={TRACK}>
              <Box width={`${clampPercent(item.percent)}%`} height={1} backgroundColor={levelColor(item.percent)} />
            </Box>
            <Text dimColor tabular>
              {item.text}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
