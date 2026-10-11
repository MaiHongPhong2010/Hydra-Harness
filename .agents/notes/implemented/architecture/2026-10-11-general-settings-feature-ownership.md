# Agent Note: General Settings and feature ownership

Status: implemented

## Problem

General Settings needs related controls that affect composer behavior, live execution, storage, and native windows. A second aggregate configuration store would duplicate the feature owners' values and bypass their validation, revisions, or lifecycle. Some controls cannot execute in a Web browser, and changing a default alone cannot establish that every live chat accepted it.

## Decision

The Settings modal projects searchable contribution labels into six typed General groups. Each feature registers its own namespace and acknowledged mutation through the existing Host settings mirror. Scalar controls save individually; Models and Plugins editors retain their existing Save/Discard behavior. Unavailable saved choices stay visible with an explanation. Desktop capabilities contribute their controls only through a trusted preload.

Permission selection combines a persisted global default with an explicit live-session broadcast. Each compatible live agent uses the existing preset setter, which records the permission, sandbox, and approval facts. Archived and cold sessions are outside the broadcast. Each target reports its own result; a repeated selection retries failures. This extends the UI behavior in [permission defaults](../feature/2026-07-31-permission-default-for-new-sessions.md) while preserving that note's logged execution-policy guarantee.

Optional-plugin disablement rejects new tool, skill, and hook work immediately, waits for owned leases to drain, then removes optional contributions. Required functionality is classified separately from restart-only `pluginType: core`; required modules and their dependency closure remain mounted. Required and optional group members project separately. The common switch preserves every plugin's individual enablement choice. Host graph frames update browser module routes and reconcile client entries through the existing serialized reload queue, including enablement after a disabled startup.

Task workspaces have validated filesystem roots and durable workspace ids but appear outside the project groups. Every projectless chat receives its own directory; changing the root affects new chats. Project pickers omit task workspaces so private chat directories cannot become project choices. The sidebar memoizes that project projection by the accepted workspace list so group-state retention runs only when the list changes. Native and WSL Hosts have separate Hydra homes. Electron owns the launcher choice, verifies a distro's Node and bridge-capable Hydra artifact without installation, and applies a pending choice only after clean shutdown. WSL native commands and browser operations cross the pipes of Electron's owned child, with a launch token; renderer IPC requires a registered Hydra window, its main frame, and the active Host origin.

Session persistence discovers raw or Zstandard encoding per artifact and preserves it through append, resume, and repair. The restart-selected compression preference affects only new session artifacts. Speed enters the logged resolved LLM request through adapter-advertised tier metadata; requested Priority can fall back to Standard when a route does not support it, and provider-reported tier stays distinct from the requested tier.

Suggestions generate one bounded batch from readable workspace files and permitted MCP resources for an empty chat, or an explicit refresh. Auxiliary model inputs and results are logged; choosing a suggestion writes only a draft. Notifications and confetti use live events rather than transcript replay. Desktop deduplicates notification delivery across its windows, and closing its last window owns Host shutdown.

## Consequences

The General shell owns layout and search, not another copy of feature configuration. A save acknowledgement proves persistence; per-session broadcast results, native execution feedback, and provider-reported tiers communicate their separate application outcomes. A rejected native preference restores the Host's current accepted value, including another window's update. Existing PTYs and stored session encodings survive preference changes. Dot notifications have no contribution until Hydra has an owning sender and delivery behavior.

## Alternatives considered

**One GeneralSettings object.** Rejected because it would duplicate values already validated and persisted by feature namespaces and obscure who applies them.

**Update permissions without recording each session.** Rejected because replay could not identify the policy governing later actions. Cold and archived chats retain their existing facts.

**Disable every entry labeled core.** Rejected because restart policy does not identify required product functionality. Explicit required metadata and dependency traversal preserve the running application.

**Translate only terminal commands for WSL.** Rejected because filesystem and subprocess operations would still run in the Windows Host and mix environments. The whole Host runs in the selected distro.

**Transcode existing histories when compression changes.** Rejected because it adds migration and crash-recovery work without changing the requested behavior for new sessions.
