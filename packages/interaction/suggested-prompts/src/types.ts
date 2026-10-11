/** Bounded prompt suggestions and their durable request vocabulary. */
import type { LlmCallConfig } from '@hydraharness/harness-llm'

/** Draft choices produced for one empty chat. */
export interface SuggestedPromptBatch { items: string[]; error?: string }

declare module '@hydraharness/harness-session/types' {
  interface SessionEventMap {
    /** Exact auxiliary model input; suggestions never enter conversation history. */
    'suggestions/request': { config: LlmCallConfig; system: string; context: string }
    /** Accepted bounded draft choices or a readable failure. */
    'suggestions/result': SuggestedPromptBatch
  }
}
