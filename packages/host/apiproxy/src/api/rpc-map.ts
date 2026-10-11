/**
 * RPC method registry and signature-derived generics. The map
 * registers only client-request methods (respond is a client-response, so it is absent);
 * map keys are the wire path segments (POST /api/session.list).
 */

import type { SessionsApi } from './sessions.ts'
import type { HostApi } from './host.ts'
import type { WorkspaceApi } from './workspace.ts'
import type { AgentPresetsApi } from './agent-presets.ts'
import type { SkillsApi } from './skills.ts'
import type { GoalsApi } from './goals.ts'
import type { ReviewApi } from './review.ts'
import type { SettingsApi } from './settings.ts'
import type { CredentialsApi } from './credentials.ts'
import type { AuthorizationApi } from './authorization.ts'
import type { WebSearchApi } from './web-search.ts'
import type { LlmApi } from './llm.ts'
import type { SubagentsApi } from './subagents.ts'
import type { RpcResponse } from './rpc.ts'

/**
 * Method name → method signature. Signatures are the single source of truth; payload/value
 * types are always derived from here. A method may declare a trailing AbortSignal after the
 * request (command.execute): the carrier passes its request signal, never a wire field.
 */
export interface RpcMethodMap {
  'review.list': ReviewApi['list']
  'review.workspace': ReviewApi['workspace']
  'review.keep': ReviewApi['keep']
  'review.undo': ReviewApi['undo']
  'session.list': SessionsApi['list']
  'session.search': SessionsApi['search']
  'session.create': SessionsApi['create']
  'session.delete': SessionsApi['delete']
  'session.history': SessionsApi['history']
  'session.models': SessionsApi['models']
  'session.suggestions': SessionsApi['suggestions']
  'session.selectModel': SessionsApi['selectModel']
  'session.rename': SessionsApi['rename']
  'session.fork': SessionsApi['fork']
  'session.revise': SessionsApi['revise']
  'session.selectVersion': SessionsApi['selectVersion']
  'session.prompt': SessionsApi['prompt']
  'session.attachment': SessionsApi['attachment']
  'session.updateQueue': SessionsApi['updateQueue']
  'session.cancel': SessionsApi['cancel']
  'subagent.list': SubagentsApi['list']
  'subagent.history': SubagentsApi['history']
  'subagent.prompt': SubagentsApi['prompt']
  'subagent.interrupt': SubagentsApi['interrupt']
  'host.describe': HostApi['describe']
  'host.pickDirectory': HostApi['pickDirectory']
  'host.listDirectory': HostApi['listDirectory']
  'host.createDirectory': HostApi['createDirectory']
  'host.openPath': HostApi['openPath']
  'workspace.list': WorkspaceApi['list']
  'workspace.create': WorkspaceApi['create']
  'workspace.rename': WorkspaceApi['rename']
  'workspace.delete': WorkspaceApi['delete']
  'workspace.insertBefore': WorkspaceApi['insertBefore']
  'workspace.insertSessionBefore': WorkspaceApi['insertSessionBefore']
  'workspace.archiveSession': WorkspaceApi['archiveSession']
  'workspace.unarchiveSession': WorkspaceApi['unarchiveSession']
  'skill.list': SkillsApi['list']
  'agentPreset.list': AgentPresetsApi['list']
  'agentPreset.select': AgentPresetsApi['select']
  'agentPreset.read': AgentPresetsApi['read']
  'agentPreset.copy': AgentPresetsApi['copy']
  'agentPreset.openDocument': AgentPresetsApi['openDocument']
  'agentPreset.remove': AgentPresetsApi['remove']
  'goal.create': GoalsApi['create']
  'goal.edit': GoalsApi['edit']
  'goal.pause': GoalsApi['pause']
  'goal.resume': GoalsApi['resume']
  'goal.complete': GoalsApi['complete']
  'goal.clear': GoalsApi['clear']
  'settings.describe': SettingsApi['describe']
  'settings.openDocument': SettingsApi['openDocument']
  'settings.update': SettingsApi['update']
  'settings.replace': SettingsApi['replace']
  'settings.mutate': SettingsApi['mutate']
  'settings.readInstructions': SettingsApi['readInstructions']
  'settings.writeInstructions': SettingsApi['writeInstructions']
  'settings.workspaceStatus': SettingsApi['workspaceStatus']
  'settings.setWorkspaceTrust': SettingsApi['setWorkspaceTrust']
  'settings.listMemories': SettingsApi['listMemories']
  'settings.removeMemory': SettingsApi['removeMemory']
  'credentials.describe': CredentialsApi['describe']
  'credentials.set': CredentialsApi['set']
  'credentials.unset': CredentialsApi['unset']
  'authorization.list': AuthorizationApi['list']
  'authorization.begin': AuthorizationApi['begin']
  'authorization.state': AuthorizationApi['state']
  'authorization.answer': AuthorizationApi['answer']
  'authorization.cancel': AuthorizationApi['cancel']
  'authorization.logout': AuthorizationApi['logout']
  'authorization.usage': AuthorizationApi['usage']
  'webSearch.providers': WebSearchApi['providers']
  'webSearch.testConnection': WebSearchApi['testConnection']
  'llm.providers': LlmApi['providers']
  'llm.models': LlmApi['models']
  'llm.discoverModels': LlmApi['discoverModels']
}

/** Business request payload of method K (reaches through the RpcRequest narrow form to payload). */
export type RequestPayload<K extends keyof RpcMethodMap> = Parameters<RpcMethodMap[K]>[0]['payload']

/** Business return value of method K (reaches through the RpcResponse narrow form to infer the ok value of result). */
export type ResponseValue<K extends keyof RpcMethodMap> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
