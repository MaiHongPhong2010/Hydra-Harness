// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { createSnapshotStore, type SessionId, type SessionListState } from '@hydraharness/harness-client-runtime/client'
import { UsageSection } from '../src/client/settings/UsageSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string): SessionId => id as SessionId

function emptyList(overrides?: Partial<SessionListState>): SessionListState {
  return {
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
    ...overrides,
  }
}

describe('UsageSection', () => {
  it('sums input and output across sessions and keeps models separate', () => {
    const a = sid('usage-a')
    const b = sid('usage-b')
    const list = createSnapshotStore<SessionListState>(emptyList({
      ids: [a, b],
      byId: {
        [a]: {
          id: a, displayTitle: a, running: false, blank: false, updatedAt: 1,
          projectionValues: {
            modelTokenUsage: [{
              provider: 'fixture', model: 'model-a', uncachedInputTokens: 1_000,
              cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 40,
            }],
          },
        },
        [b]: {
          id: b, displayTitle: b, running: false, blank: false, updatedAt: 2,
          projectionValues: {
            modelTokenUsage: [
              {
                provider: 'fixture', model: 'model-a', uncachedInputTokens: 100,
                cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10,
              },
              {
                provider: 'fixture', model: 'model-b', uncachedInputTokens: 20,
                cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 400,
              },
            ],
          },
        },
      },
      current: a,
    }))
    const unusedHook = (() => { throw new Error('unused') }) as never
    render(<UsageSection
      close={() => {}}
      openSection={vi.fn()}
      refresh={async () => {}}
      useSessions={bindSnapshotSelector(list)}
      useWorkspaces={unusedHook}
      t={makeTranslate(en)}
    />)

    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[1]!).getByText('model-a')).toBeDefined()
    expect(within(rows[1]!).getByText('1,600')).toBeDefined()
    expect(within(rows[1]!).getByText('50')).toBeDefined()
    expect(within(rows[2]!).getByText('model-b')).toBeDefined()
    expect(within(rows[2]!).getByText('20')).toBeDefined()
    expect(within(rows[2]!).getByText('400')).toBeDefined()
  })

  it('refreshes the session list on mount and redraws when modelTokenUsage lands', async () => {
    const a = sid('usage-live')
    const list = createSnapshotStore<SessionListState>(emptyList({
      ids: [a],
      byId: {
        [a]: {
          id: a, displayTitle: a, running: false, blank: false, updatedAt: 1,
        },
      },
      current: a,
    }))
    const refresh = vi.fn(async () => {})
    const unusedHook = (() => { throw new Error('unused') }) as never
    render(<UsageSection
      close={() => {}}
      openSection={vi.fn()}
      refresh={refresh}
      useSessions={bindSnapshotSelector(list)}
      useWorkspaces={unusedHook}
      t={makeTranslate(en)}
    />)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText('No token usage yet.')).toBeDefined()

    await act(async () => {
      list.set({
        ...list.getSnapshot(),
        byId: {
          [a]: {
            id: a, displayTitle: a, running: false, blank: false, updatedAt: 2,
            projectionValues: {
              modelTokenUsage: [{
                provider: 'fixture', model: 'live-model', uncachedInputTokens: 42,
                cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 7,
              }],
            },
          },
        },
      })
    })

    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(rows[1]!).getByText('live-model')).toBeDefined()
    expect(within(rows[1]!).getByText('42')).toBeDefined()
    expect(within(rows[1]!).getByText('7')).toBeDefined()
  })
})
