/** Live effects are separate from durable transcript replay. */
import type { SessionId } from '@hydraharness/harness-session/types'
import type { Branded } from '@hydraharness/harness-brand'

/** Identity of one user-requested effect. */
export type ConfettiId = Branded<'ConfettiId'>

/** Bounded presentation requested by a human command. */
export interface ConfettiRequest {
  id: ConfettiId
  sessionId: SessionId
  particles: number
  durationMs: number
}

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * A human requested one transient effect; renderers may display it unless reduced motion is active.
     * @mode parallel
     * @param request - bounded effect and destination chat; never emitted from history.
     */
    'toys/confetti'(request: ConfettiRequest): void
  }
}
