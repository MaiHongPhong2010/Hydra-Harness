// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { displayProjects } from '../src/client/organization.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

beforeEach(() => { localStorage.clear() })

describe('session sidebar organization', () => {
  it('moves display membership once, removes it, and falls back when the target is deleted', () => {
    const projects = [
      { workspaceId: 'one', sessionIds: ['session'], path: '/one' },
      { workspaceId: 'two', sessionIds: [], path: '/two' },
    ] as never
    const moved = displayProjects(projects, { session: 'two' }, ['session'] as never)
    expect(moved.map(project => project.sessionIds)).toEqual([[], ['session']])
    expect(displayProjects(projects, { session: null }, ['session'] as never).map(project => project.sessionIds)).toEqual([[], []])
    expect(displayProjects(projects, { session: 'deleted' }, ['session'] as never)).toBe(projects)
    expect(displayProjects(projects, { unknown: 'two' }, ['session'] as never).map(project => project.sessionIds)).toEqual([['session'], []])
  })

  it('preserves earlier view preferences and persists new organization choices', () => {
    const initial = createWorkspaceViewStore().create()
    const old = initial.getSnapshot()
    const { pinnedSessionIds: _pin, unreadSessionIds: _unread, sections: _sections,
      sectionBySession: _section, projectBySession: _project, ...earlierState } = old
    localStorage.setItem('hydra.workspace.view.v5', JSON.stringify({ ...earlierState, groupBy: 'flat' }))
    const store = createWorkspaceViewStore().create()
    store.actions.togglePinned('session')
    store.actions.setUnread('session', true)
    store.actions.addSection('section', 'Review', 'session')
    store.actions.setProject('session', 'project')
    const restored = createWorkspaceViewStore().create().getSnapshot()
    expect(restored).toMatchObject({ groupBy: 'flat', pinnedSessionIds: ['session'], unreadSessionIds: ['session'],
      sections: [{ id: 'section', title: 'Review' }], sectionBySession: { session: 'section' }, projectBySession: { session: 'project' } })
    store.actions.togglePinned('session')
    store.actions.setUnread('session', false)
    store.actions.setSection('session', null)
    expect(store.getSnapshot()).toMatchObject({ pinnedSessionIds: [], unreadSessionIds: [], sectionBySession: {} })
  })
})

it('moves an existing session into another custom section', () => {
  const store = createWorkspaceViewStore().create()
  store.actions.addSection('one', 'One', 'session')
  store.actions.addSection('two', 'Two', 'other')
  store.actions.setSection('session', 'two')
  expect(store.getSnapshot().sectionBySession).toEqual({ session: 'two', other: 'two' })
})
