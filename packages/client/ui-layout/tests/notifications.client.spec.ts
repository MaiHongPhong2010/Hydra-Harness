// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@hydraharness/harness-client-test-runtime'
import type { ISessions, SessionId } from '@hydraharness/harness-client-runtime/client'
import type { NotificationId, NotificationRequest, NotificationSettings } from '@hydraharness/harness-notifications/types'
import type { NativePreferencesApi } from '../src/client/desktop-preferences.ts'
import { NotificationsController, shouldNotify } from '../src/client/NotificationsController.ts'

const policy: NotificationSettings = { completion: 'background', questions: true, permissionPrompts: true, sound: 'default' }
const request: NotificationRequest = { id: 'turn:s:1' as NotificationId, sessionId: 's' as SessionId, kind: 'completion', title: 'Hydra', body: 'Finished' }

describe('live notifications', () => {
  it.each(['never', 'background', 'always'] as const)('uses %s completion policy independently of question policy', (completion) => {
    expect(shouldNotify(request, { ...policy, completion }, true)).toBe(completion === 'always')
    expect(shouldNotify(request, { ...policy, completion }, false)).toBe(completion !== 'never')
    expect(shouldNotify({ ...request, kind: 'question' }, { ...policy, completion }, true)).toBe(true)
    expect(shouldNotify({ ...request, kind: 'question' }, { ...policy, questions: false, completion }, false)).toBe(false)
  })
  it('deduplicates a live fact and passes policy and chat identity to the native coordinator', async () => {
    const scope = stubSettingsScope<NotificationSettings>()
    scope.publish({ status: 'ready', value: policy, writable: true })
    const notify = vi.fn(async () => ({ delivered: true }))
    const controller = new NotificationsController(scope.scope, { open: vi.fn() } as unknown as ISessions,
      { notify } as unknown as NativePreferencesApi)
    await controller.deliver(request)
    await controller.deliver(request)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith({ ...request, silent: false, completionPolicy: 'background' })
  })
  it('shows native delivery failures without prompting display permission automatically', async () => {
    const scope = stubSettingsScope<NotificationSettings>()
    scope.publish({ status: 'ready', value: policy, writable: true })
    const prompt = vi.fn(async () => {})
    const controller = new NotificationsController(scope.scope, { open: vi.fn() } as unknown as ISessions,
      { notify: async () => { throw new Error('OS refused') }, openNotificationSettings: prompt } as unknown as NativePreferencesApi)
    await controller.deliver(request)
    expect(controller.permission.getSnapshot().error).toBe('OS refused')
    expect(prompt).not.toHaveBeenCalled()
    await controller.requestPermission()
    expect(prompt).toHaveBeenCalledOnce()
  })
})
