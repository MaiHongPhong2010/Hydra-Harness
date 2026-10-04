/** Native account OAuth prompts hide pasted browser callback codes. */
import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { createPiAiAuthInteraction } from '@hydraharness/harness-llm-pi-ai'

/** Translate SDK login notices and prompts into the authorization service.
 * @param session - authorization interaction and cancellation.
 * @returns the SDK interaction for this login attempt.
 */
export function accountInteraction(session: AuthorizationSession): AuthInteraction {
  return createPiAiAuthInteraction(session, 'secret')
}
