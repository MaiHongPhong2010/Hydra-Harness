/** Client-safe live notification facts and accepted user choices. */
import type { SessionId } from '@hydraharness/harness-session/types'
import type { Branded } from '@hydraharness/harness-brand'

/** Stable identity for one live delivery fact across connected windows. */
export type NotificationId = Branded<'NotificationId'>

/** Stable identity and chat destination; emitted for live events rather than transcript replay. */
export interface NotificationRequest {
  id: NotificationId
  sessionId: SessionId
  kind: 'completion' | 'question'
  title: string
  body: string
}

/** Notification choices are independent of browser and OS display permission. */
export interface NotificationSettings {
  completion: 'never' | 'background' | 'always'
  permissionPrompts: boolean
  questions: boolean
  sound: 'default' | 'off'
}

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * A live turn ended or a new question awaits an answer; connected providers may deliver it.
     * @mode parallel
     * @param request - stable delivery identity and destination chat.
     */
    'notifications/requested'(request: NotificationRequest): void
  }
}
