import { expect, mock, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const usageOf = (u: Partial<TurnUsage>): TurnUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
  ...u,
})

test('band shows cost, cache hit rate and the cache countdown', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.store(on)

  // Engine beneath: každý step odpoví usage, kterou test nastaví
  let next: TurnUsage | null = null
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: next }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  const step = async (usage: TurnUsage, agentId?: string): Promise<void> => {
    next = usage
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of stream) {
      // chunky nás nezajímají
    }
    await stream.result
  }

  await $.session.measure({
    context: { window: 1_000_000, tokens: 100_000, percent: 10 },
    rateLimits: [],
    cost: { usd: 1.234 },
    changed: ['context', 'cost'],
  })

  // t=0: zápis do 1h cache; t=60 s: čtení z ní
  await step(usageOf({ input_tokens: 100, cache_creation_input_tokens: 9_900, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9_900 }))
  await clock.advance(60_000)
  await step(usageOf({ input_tokens: 50, cache_read_input_tokens: 10_000 }))
  // Subagent se nepočítá do hit rate ani neposouvá lhůtu
  await clock.advance(1_000)
  await step(usageOf({ input_tokens: 500_000 }), 'agent-1')

  let ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /^≈\$/ }))?.text).toBe('≈$1.23')
  // ctx: procento uvnitř baru, tokeny za ním
  expect(await ui.find({ type: 'Text', text: /^10%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^100k\/1000k$/ })).toBeDefined()
  // 10 000 / (100 + 9 900 + 50 + 10 000) = 49,9 %
  expect(await ui.find({ type: 'Text', text: /^50%$/ })).toBeDefined()
  const fresh = await ui.find({ type: 'Text', text: /^\d+m$/ })
  expect(fresh?.text).toBe('59m')
  expect(fresh?.props.color).toBe(undefined)
  await ui.unmount()

  // 200 s do konce: žlutá s vteřinami
  await clock.set(60_000 + 3_600_000 - 200_000)
  ui = await $.ui.mount(BAND)
  const soon = await ui.find({ type: 'Text', text: /^3m 20s$/ })
  expect(soon?.props.color).toBe('warning')
  await ui.unmount()

  // Po lhůtě: vypršelo, červená
  await clock.set(60_000 + 3_600_000 + 1)
  ui = await $.ui.mount(BAND)
  const gone = await ui.find({ type: 'Text', text: /^expired$/ })
  expect(gone?.props.color).toBe('error')
  await ui.unmount()
})

test('a limit over 70 % keeps its percent visible, dark on the amber fill', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1_000_000, tokens: 1_000, percent: 0 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 87, resetsAt: new Date(3_600_000 * 95).toISOString() }],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount(BAND)
  const inner = await ui.find({ type: 'Text', text: /^87%$/ })
  expect(inner?.props.color).toBe('#1f1f1f')
  expect(await ui.find({ type: 'Text', text: /^3d 23h$/ })).toBeDefined()
  await ui.unmount()
})

test('band and footer draw at start even when no hook filled the state yet', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on, { limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(3_600_000).toISOString() }] })
  mock.env(on, {})
  // Engine beneath: session.start ani session.measure neproběhly, jen dotazy na $ odpovídají
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('session.root', () => ({ value: 'C:\\work\\claude-mods' }))
  on('vcs.detect', (_, e) => ({
    vcs: 'git',
    root: e.path,
    mainRoot: e.path,
    revision: '414fac2',
    branch: 'main',
    defaultBranch: 'main',
    remote: null,
  }))
  on('session.surfaces', () => ({ value: ['desktop'] }))

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^ctx$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^40%$/ })).toBeDefined()
  await band.unmount()

  const footer = await $.ui.mount({ plugin: 'usage-band', component: 'SessionMode', surface: 'desktop', props: { modes: [] } })
  const text = (await footer.find({ type: 'Text' }))?.text ?? ''
  expect(text.includes('claude-mods')).toBe(true)
  expect(text.includes('main')).toBe(true)
  await footer.unmount()
})

test('after a restart the cache item comes back from the store', async ($, on) => {
  const now = 10 * 86_400_000
  mock.clock(on, { now })
  // Uloženo předchozím procesem téže session před 20 min; jiná session před 8 dny
  mock.store(on, {
    'cache:sess-1': { at: now - 1_200_000, ttl: '1h', read: 9_000, total: 10_000 },
    'cache:old': { at: now - 8 * 86_400_000, ttl: '1h', read: 1, total: 2 },
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1_000_000, tokens: 1_000, percent: 0 },
    rateLimits: [],
    changed: ['context'],
  })

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^90%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^40m$/ })).toBeDefined()
  await ui.unmount()
})

test('without any cache reading the band shows no cache item', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 1_000_000, tokens: 1_000, percent: 0 },
    rateLimits: [],
    changed: ['context'],
  })

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^cache$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^≈\$/ })).toBe(undefined)
  await ui.unmount()
})
