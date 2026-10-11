// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@hydraharness/harness-client-test-runtime'
import { ComposerSubmissionPolicy } from '../src/client/input/submission-policy.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'

describe('composer preferences', () => {
  it.each(['queue', 'steer'] as const)('resolves both shortcuts with %s follow-ups, including Send', (preferred) => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new ComposerSubmissionPolicy(host.scope)
    const opposite = preferred === 'queue' ? 'steer' : 'queue'
    for (const shortcut of ['enter', 'mod-enter'] as const) {
      host.publish({ status: 'ready', writable: true, value: { busyEnter: preferred, sendShortcut: shortcut } })
      expect(policy.resolve(true, 'send', true)).toBe(preferred)
      expect(policy.resolve(true, 'enter', true)).toBe(preferred)
      expect(policy.resolve(true, 'accelerated', true)).toBe(shortcut === 'enter' ? opposite : preferred)
      expect(policy.resolve(true, 'alternate', true)).toBe(opposite)
      expect(policy.resolve(true, 'alternate', false)).toBe('queue')
      expect(policy.resolve(false, 'alternate', true)).toBe('queue')
    }
  })

  it('uses existing defaults, follows Host acceptance, and rejects unacknowledged writes', async () => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new ComposerSubmissionPolicy(host.scope)
    expect(policy.preferences.getSnapshot()).toEqual({ busyEnter: 'queue', plainText: false, showContextUsage: true, sendShortcut: 'enter' })
    await expect(policy.save('plainText', true)).rejects.toThrow('read only')
    host.publish({ status: 'ready', writable: true, revision: 1, value: { busyEnter: 'queue' } })
    await expect(policy.save('plainText', true)).rejects.toThrow('Could not save')
    expect(policy.preferences.getSnapshot().plainText).toBe(false)
    host.set.mockImplementation((field: string, value: unknown) => {
      host.publish({ value: { busyEnter: 'queue', [field]: value }, revision: 2 })
    })
    await policy.save('plainText', true)
    expect(policy.preferences.getSnapshot().plainText).toBe(true)
    await expect(new ComposerSubmissionPolicy().save('plainText', true)).rejects.toThrow('unavailable')
  })
})
