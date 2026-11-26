import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit, TurnUsage } from 'claude-code'

import type { Cache, Limit, Usage } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const cost = atom({ plugin: 'usage-band', key: 'cost' } as const, null)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null)

const refreshCost = async ($: EngineInterface, value: SessionCost | undefined): Promise<void> => {
  if (value === undefined) return
  await update($, cost, () => value.usd)
}

// Životnost zápisu: při zápisu obou délek platí kratší (jako AgentRequest.cacheTtl);
// request, který jen četl, prodlužuje lhůtu té délky, kterou dostal poslední zápis
const writtenTtl = (u: TurnUsage): '5m' | '1h' | null =>
  (u.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : (u.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : null

const nextCache = (prev: Cache | null, u: TurnUsage, at: number): Cache => {
  const ttl = writtenTtl(u) ?? prev?.ttl ?? null
  const isTouched = u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0
  return {
    at: isTouched ? at : (prev?.at ?? at),
    ttl,
    read: (prev?.read ?? 0) + u.cache_read_input_tokens,
    total: (prev?.total ?? 0) + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens,
  }
}

const TTL_MS = { '5m': 300_000, '1h': 3_600_000 } as const
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

// Od poloviny je výplň širší než zbytek: procento patří do ní
const isInFill = (percent: number): boolean => clampPercent(percent) >= 50

// Procento ve výplni: na žluté tmavé, jinak výchozí (světlé)
const DARK = '#1f1f1f'
const innerColor = (percent: number): string | undefined =>
  levelColor(percent) === 'warning' ? DARK : undefined

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

// Odhad /cost, ne faktura: proto "≈"
const formatUsd = (usd: number): string => `≈$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

// Zbývající doba cache jako "42m" / "3m 20s"; null = vypršela
const cacheLeft = (c: Cache, now: number): { text: string; ms: number } | null => {
  if (c.ttl === null) return null
  const ms = c.at + TTL_MS[c.ttl] - now
  if (ms <= 0) return { text: 'expired', ms: 0 }
  const seconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 5) return { text: `${minutes}m`, ms }
  return { text: minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`, ms }
}

// Do 5 minut žlutá, vypršelá červená (další prompt zapíše cache znovu)
const ttlColor = (ms: number): string | undefined => (ms <= 0 ? 'error' : ms <= 300_000 ? 'warning' : undefined)

// inner = procento v baru, outer = detail za barem
type Item = { key: string; label: string; percent: number; inner: string; outer: string }

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
    await refreshCost($, current.cost)
    // Odpočet cache se mění i bez událostí: překreslit pás každých 10 s
    $.clock.every(10_000, () => $.ui.invalidate('ui.render'))
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
    await refreshCost($, e.cost)
    return next(e)
  })

  // Cache hit rate a TTL jen z hlavní smyčky: subagenti mají vlastní cache.
  // Lhůta běží od odeslání requestu, ne od konce odpovědi
  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const result = yield* next(e)
    const u = result.usage
    if (e.agentId === undefined && u !== null) {
      await update($, cache, prev => nextCache(prev, u, at))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const value = await read($, usage)
    if (e.props.hasSurvey || value === null) {
      return next(e)
    }

    const usd = await read($, cost)
    const c = await read($, cache)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const hitRate = c !== null && c.total > 0 ? Math.round((c.read / c.total) * 100) : null
    const left = c !== null ? cacheLeft(c, now) : null
    const percent = value.percent ?? 0
    const items: Item[] = [
      {
        key: 'ctx',
        label: 'ctx',
        percent,
        inner: value.tokens === undefined ? '—' : `${percent}%`,
        outer:
          value.tokens === undefined
            ? kTokens(value.window)
            : `${kTokens(value.tokens)}/${kTokens(value.window)}`,
      },
      ...value.limits.map(l => ({
        key: l.kind,
        label: LABELS[l.kind] ?? l.kind,
        percent: l.percentUsed,
        inner: `${Math.round(l.percentUsed)}%`,
        outer: untilReset(l.resetsAt, now).trim(),
      })),
    ]

    // Každá položka dostane stejný díl šířky, pruh vyplní zbytek.
    // Výplň leží absolutně pod procentem, které je vycentrované v toku
    return (
      <Box flexDirection="row" width="100%" alignItems="center" gap={3}>
        {items.map(item => (
          <Box key={item.key} flexDirection="row" flexGrow={1} flexShrink={1} alignItems="center" gap={1}>
            <Text dimColor>{item.label}</Text>
            {/* Výplň a zbytek vedle sebe, bez překryvu: desktop kreslí absolutní
                Box nad textem bez ohledu na pořadí. Procento jde do širšího dílu */}
            <Box flexDirection="row" flexGrow={1} height={1} minWidth={6} backgroundColor={TRACK}>
              <Box
                width={`${clampPercent(item.percent)}%`}
                flexShrink={0}
                height={1}
                backgroundColor={levelColor(item.percent)}
                justifyContent="center"
                alignItems="center"
              >
                {isInFill(item.percent) ? (
                  <Text tabular color={innerColor(item.percent)}>
                    {item.inner}
                  </Text>
                ) : null}
              </Box>
              <Box flexGrow={1} height={1} justifyContent="center" alignItems="center">
                {isInFill(item.percent) ? null : <Text tabular>{item.inner}</Text>}
              </Box>
            </Box>
            {item.outer !== '' ? (
              <Text dimColor tabular>
                {item.outer}
              </Text>
            ) : null}
          </Box>
        ))}
        {hitRate !== null || left !== null ? (
          <Box flexDirection="row" flexShrink={0} alignItems="center" gap={1}>
            <Text dimColor>cache</Text>
            {hitRate !== null ? (
              <Text dimColor tabular>
                {`${hitRate}%`}
              </Text>
            ) : null}
            {left !== null ? (
              <Text tabular color={ttlColor(left.ms)} dimColor={ttlColor(left.ms) === undefined}>
                {left.text}
              </Text>
            ) : null}
          </Box>
        ) : null}
        {usd !== null ? (
          <Box flexShrink={0}>
            <Text dimColor tabular>
              {formatUsd(usd)}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
