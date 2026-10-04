import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@hydraharness/harness-timeout'
import { resolveProfiles, type AccountProviderProfile } from '../src/config.ts'

describe('account provider settings', () => {
  it.each(['bad', 'us_east_1'])('rejects an invalid Kiro region %s', (region) => {
    expect(() => resolveProfiles({ kiro: { region } })).toThrow('invalid AWS region')
  })

  it('retains valid Kiro controls and rejects unsupported generation controls', () => {
    const profile: AccountProviderProfile = { region: 'us-east-1', timeoutMs: 1000, retryPolicy: JSON.parse('{}') as NonNullable<AccountProviderProfile['retryPolicy']>, startURL: 'https://fixture.test/start', issuerURL: 'https://fixture.test/issuer' }
    expect(resolveProfiles({ kiro: profile }).get('kiro')).toEqual(profile)
    expect(() => resolveProfiles({ kiro: { transport: 'sse' } })).toThrow('Kiro does not support transport')
  })

  it.each(['startURL', 'issuerURL'] as const)('rejects unsafe %s values', (field) => {
    for (const value of ['http://fixture.test', 'https://user@fixture.test', 'https://:password@fixture.test', 'https://fixture.test/#fragment']) {
      expect(() => resolveProfiles({ kiro: { [field]: value } })).toThrow('must use HTTPS')
    }
  })

  it.each(['loginTimeoutMs', 'loginPollIntervalMs', 'timeoutMs'] as const)('rejects invalid Kiro %s values', (field) => {
    for (const value of [0.5, 0, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => resolveProfiles({ kiro: { [field]: value } })).toThrow('positive timer interval')
    }
  })

  it.each(['https://user@fixture.test', 'https://:password@fixture.test', 'https://fixture.test/?query',
    'https://fixture.test/#fragment', 'http://fixture.test', 'ftp://localhost'])('rejects unsafe API endpoint %s', (endpoint) => {
    expect(() => resolveProfiles({ chatgpt: { endpoint } })).toThrow('must use HTTPS or loopback HTTP')
  })

  it.each(['https://fixture.test', 'http://127.0.0.1', 'http://localhost', 'http://[::1]'])('accepts secure or loopback API endpoint %s', (endpoint) => {
    expect(resolveProfiles({ chatgpt: { endpoint } }).get('chatgpt')?.endpoint).toBe(endpoint)
  })

  it('keeps absent providers dormant and treats empty model lists as discovery', () => {
    expect(resolveProfiles(undefined).size).toBe(0)
    expect(resolveProfiles({ chatgpt: {}, antigravity: { models: [] } }))
      .toEqual(new Map([['chatgpt', {}], ['antigravity', {}]]))
  })

  it('detaches configured model rows and retains valid provider controls', () => {
    const models = [{ id: 'one' }, { id: 'two', name: 'Two', contextWindow: 4096, maxTokens: 1024 }]
    const profile: AccountProviderProfile = {
      models, endpoint: 'https://fixture.test', callbackPath: '/oauth/callback', callbackPort: 0,
      onboardingAttempts: 1, onboardingDelayMs: 0, defaultContextWindow: 8192,
      defaultMaxTokens: 2048, maxRequestImageBytes: 1024, streamIdleTimeoutMs: MAX_TIMER_DELAY_MS,
    }
    const resolved = resolveProfiles({ antigravity: profile }).get('antigravity')!
    expect(resolved).toEqual(profile)
    expect(resolved).not.toBe(profile)
    expect(resolved.models).not.toBe(models)
    expect(resolved.models?.[0]).not.toBe(models[0])
    models[1]!.name = 'Changed'
    expect(resolved.models?.[1]?.name).toBe('Two')
  })

  it.each(['unknown', 'gemini-web'])('rejects unsupported route %s', (provider) => {
    expect(() => resolveProfiles({ [provider]: {} })).toThrow('unknown provider')
  })
  it('accepts Kiro selector classification while retaining unsupported output-cap rejection', () => {
    expect(resolveProfiles({ kiro: { models: [{ id: 'alias', endpoints: ['images/generations', 'videos'] }] } })
      .get('kiro')?.models?.[0]?.endpoints).toEqual(['images/generations', 'videos'])
    expect(() => resolveProfiles({ kiro: { models: [{ id: 'alias', maxTokens: 100 }] } }))
      .toThrow('Kiro models do not support maxTokens')
  })

  it('infers image output families and retains explicit alias endpoints independently of vision input', () => {
    const endpoints = ['images/generations']
    const models = resolveProfiles({ antigravity: { models: [
      { id: 'gemini-3.1-flash-image' }, { id: 'gemini-3.1-pro' }, { id: 'alias', endpoints },
    ] } }).get('antigravity')!.models!
    expect(models[0]?.endpoints).toEqual(['images/generations'])
    expect(models[1]?.endpoints).toBeUndefined()
    expect(models[2]?.endpoints).toEqual(endpoints)
    expect(models[2]?.endpoints).not.toBe(endpoints)
    expect(() => resolveProfiles({ antigravity: { models: [{ id: 'alias', endpoints: ['https://wrong.test'] }] } })).toThrow('invalid endpoints')
  })

  it.each<[keyof AccountProviderProfile, unknown[], string]>([
    ['endpoint', [' ', ''], 'empty endpoint'],
    ['callbackPath', ['callback', '/callback?query'], 'callbackPath'],
    ['callbackPort', [0.5, -1, 65536], 'callbackPort'],
    ['onboardingAttempts', [0.5, 0], 'onboardingAttempts'],
    ['onboardingDelayMs', [Infinity, -1], 'onboardingDelayMs'],
    ['defaultContextWindow', [1.5, 0], 'defaultContextWindow'],
    ['defaultMaxTokens', [1.5, 0], 'defaultMaxTokens'],
    ['streamIdleTimeoutMs', [Infinity, 0, MAX_TIMER_DELAY_MS + 1], 'streamIdleTimeoutMs'],
    ['maxRequestImageBytes', [1.5, 0], 'maxRequestImageBytes'],
  ])('rejects invalid %s values', (field, values, message) => {
    for (const value of values) {
      expect(() => resolveProfiles({ chatgpt: { [field]: value } })).toThrow(message)
    }
  })

  it.each([
    [{ id: '' }, 'empty model id'],
    [{ id: 'one', name: '' }, 'empty name'],
    [{ id: 'one', contextWindow: 0 }, 'contextWindow'],
    [{ id: 'one', contextWindow: 1.5 }, 'contextWindow'],
    [{ id: 'one', maxTokens: 0 }, 'maxTokens'],
    [{ id: 'one', maxTokens: 1.5 }, 'maxTokens'],
  ] as const)('rejects invalid model metadata %j', (model, message) => {
    expect(() => resolveProfiles({ chatgpt: { models: [model] } })).toThrow(message)
  })

  it('rejects duplicate model identifiers', () => {
    expect(() => resolveProfiles({ chatgpt: { models: [{ id: 'one' }, { id: 'one' }] } }))
      .toThrow('repeats model "one"')
  })
})
