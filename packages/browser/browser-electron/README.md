# @hydraharness/harness-browser-electron

Owner-scoped embedded browser. `BrowserSessionService` registers as `ctx.browsers`, starts one Electron window per `Agent` on that agent's first action, and closes it with the agent. Its native chrome lets the user add, select, and close tabs, follows the desktop light/dark theme, and shows an agent status line, HTTPS lock, loading spinner, and tab favicons. Hydra owns the reasoning loop: each controlled page exposes a Playwright-style accessibility snapshot with numbered refs; PageController remains the private DOM execution fallback for those refs. `PageAgentCore` is constructed only when an explicit `page_agent_run` arrives. Hydra harness keeps the upstream Panel out of the webpage and hides PageController's index boxes and labels while retaining the simulator cursor and explicit annotation selection. The gradient follows pending browser commands, including activity received before document initialization; the virtual cursor remains visible during manual browsing without blocking input. The native toolbar fits narrow panels, overflowing tabs scroll horizontally, and the page viewport follows the panel dimensions. Playwright pointer and form actions await the simulator cursor movement through the preload before executing the native action. Indexed clicks reject when their viewport point is covered by another page element, so actions cannot click through popups or headers.

## Provenance

Hydra is a public fork of DeepSeek Harness (DSH). The Electron browser integration, Hydra preload bridge, package ownership, and cursor/mask changes are maintained in this fork. The BrowserAgent Core, LLM client, and PageController source are derived from Alibaba PageAgent v1.12.4. The copied source keeps Alibaba's copyright and MIT license in [`third-party/browseragent/LICENSE`](third-party/browseragent/LICENSE); the repository-level [third-party notice](../../../THIRD_PARTY_NOTICES.md) records both the upstream source and Hydra's modifications.

## Contract

An acknowledged action and its following observation have independent outcomes. If a full trailing read fails, `perform` retains `action`, returns `observationError`, and reads native metadata without the preload. The fallback contains no page contents and is `settled:false`; it does not refresh numeric refs or prove an outcome. Explicit read failures, cancellation, action request failures, and unavailable metadata remain errors. An action request timeout leaves its effect unknown rather than proving failure.

`select_text` selects complete contents for a named or indexed element, including multiline text and input/textarea values. Four viewport coordinates select a partial range; input and textarea drags use Chromium native mouse input. The action resolves after the final selection update and returns the actual selected text. Empty selections and unsupported or password inputs do not report success.

- One `Agent` owns one window. `perform(owner, action)` starts it lazily; there is no explicit open call, because "open a browser" is not a decision the model should make separately from using one. An optional `homeUrl` loads before the child reports ready, so a fresh window opens on the configured site rather than `about:blank`.
- `currentPage(owner, execution, tabId)` reads the live URL, title, tab ids, and loading state without refreshing accessibility state or opening a browser; it returns `undefined` when the owner has no open browser and follows the Browsing policy and cancellation signal.
- Every `perform` ends with a state read. With `captureState: false`, that read returns identity, tabs, native loading, and dialogs without traversing the page or refreshing numeric indexes. Captured navigation, tab-change, and explicit state observations wait boundedly for Chromium to be idle and the SPA to expose content; a title alone is insufficient. Unchanged observations of a settled document return without another quiet-period wait; `settled: false` makes an exhausted wait explicit rather than treating an empty shell as final UI evidence. `PageController` assigns element indices while building the tree, so the trailing snapshot both answers the caller and leaves the next action addressable.
- Page-local actions may name a stable `tabId`. Calls for one tab are serialized because each trailing state read replaces that tab's valid element indices; calls for different explicit tabs may overlap. Untargeted and tab-lifecycle actions are window-wide barriers and capture the selected tab when Electron receives them.
- Actions use page-agent's own wire names (`click_element`, `input_text`, `select_option`, `scroll`, `scroll_horizontally`, `execute_javascript`, `get_browser_state`) plus harness navigation, readiness, tab, find, fill, and upload actions. `navigate`/`back`/`forward`/`press`/`wait`/tab actions/`upload_file` are answered by the Electron main process; page actions reach the preload. Clicks move the simulator cursor and use Chromium's native mouse move, press, and release events. Click, hover, type, select, and fill accept an index, visible `name`, or `target` containing a unique CSS selector or observed Playwright ref. Numeric indexes and Playwright refs address different namespaces. The first agent page action reveals the desktop Browser panel.
- `takeScreenshot(owner)` is a separate read contract: Electron captures only the selected controlled page's visible viewport through `WebContents.capturePage()`, never a background tab or Browser chrome. The transient canonical PNG is bounded to 3,500,000 bytes and 2,000 pixels per edge and is accepted only for an HTTP(S) page; the model-facing consumer must replace its base64 with a durable attachment before returning.
- PageAgent's own OpenAI-shaped LLM calls cross one private Electron IPC channel to the owning Hydra agent, which runs its currently selected provider and model. The page never sees an API key, a model endpoint, or Hydra IPC. `PageAgentCore` is created only for `page_agent_run`.
- The native chrome mirrors every tab title, favicon, and the selected tab's URL. Its omnibox opens an `http:` or `https:` address directly; any other text searches Google. An agent status line reports the current Hydra action. Agent Back, Forward, and Reload do not reapply the default navigation policy to existing history entries, but an exact-origin site block still vetoes them; selecting another tab does not cancel work explicitly targeted at the previous one.
- When embedded in the desktop app, the resolved theme presenter sends the active light/dark scheme and semantic palette to the native chrome, keeping its shell, tabs, controls, omnibox, and status bar aligned with the app. Clearing the override sends `null`, removes renderer color values, and restores Electron's OS color preference; standalone chrome uses that preference by default. Theme presenter and chrome UI tests cover the initial mapping, scheme switches, and reset behavior.
- Each controlled tab enforces the configured navigation policy before agent loads from `navigate` and `open_new_tab`, popup requests, page links, redirects, and the configured home page. Global `block` denies navigation; otherwise same-origin navigation proceeds and non-HTTP(S) navigation is blocked. Cross-origin `ask` requires a one-time Host approval without creating a site rule. Explicit agent navigation approval covers its exact URL; redirects to another destination still check policy. Allowed `window.open()` pages are adopted into a controlled tab.
- Direct native input, browser controls, and desktop-routed URLs put the tab under user control. Navigation policy does not restrict the user's HTTP(S) browsing, including later links, redirects, popups, and history navigation. The next agent command targeting that tab restores agent navigation checks.
- A navigation, renderer crash, tab close, or user closing the window invalidates the affected indices. In-flight page calls reject rather than resolving against a different or missing document, and the next `perform` after a closed window starts a fresh one. Blocked requests and downloads retain the current document's preload readiness; a committed replacement waits for `dom-ready`. In the desktop embedding, closing the last tab hides the Browser panel while keeping the owner connection alive; the next page action, including `open_new_tab`, reveals the panel and creates a fresh controlled tab. An explicit `tabId` that no longer exists returns an action failure.
- Failures are machine-routable through `BrowserError.code`: `BROWSER_UNAVAILABLE` (no `electron` installed), `BROWSER_LAUNCH_FAILED` (with the child's stderr tail), `BROWSER_GONE`, `BROWSER_TIMEOUT`, `BROWSER_DISPOSING`, `BROWSER_DISABLED` when the durable `browser-electron.controlEnabled` setting is off, and `BROWSER_POLICY_DENIED` when upload, sensitive-history, or Full CDP settings or approval deny an operation. Disabling control also stops detached PageAgent loops in every open tab and rejects their later model requests; one ordinary action already executing may finish.
- Cancellation withdraws permissions, disconnects pending Playwright locators without closing their tab, and waits for the request to finish before releasing the owner queue. Already-dispatched preload work may finish before cancellation is acknowledged. A timed-out request receives cancellation first; an unresponsive child is closed after the shutdown grace period. Desktop owner changes cancel and join the previous owner's requests. An action that the page rejects is not an error. `{ success: false, message }` is a result the model can read and act on; only the transport and the process lifecycle throw.

`get_browser_state.snapshot` requests Playwright's distilled accessibility tree with optional target, depth, and boxes, preserving password-value redaction. `find_element` searches that tree for text or regex and returns snippets. Diagnostic URL filtering preserves retained event indexes. The Playwright transport refreshes Runtime announcements on connection so prior diagnostic capture cannot hide existing execution contexts. Native action waits temporarily disable renderer throttling so occluded tabs continue producing animation frames.

Each document owns one `MutationObserver` for child, visibility, disclosure, role, and style changes. It ignores Hydra overlays and waits for a short quiet period before comparing accessibility entries by DOM identity. The optional `uiChanges` reports at most 20 shown, hidden, expanded, collapsed, or changed entries per category plus newly focused content. Readiness reads retain these deltas until returning the final state.

The seam contains no tool schema, prompt, or model-facing rendering policy. It owns durable browser settings, native policy enforcement, and Host approvals for browsing, downloads, uploads, sensitive-history searches, and Full CDP operations; `@hydraharness/harness-tool-browser` owns everything the model sees.

## Settings and browser management

Settings → Browser presents global **Browser permissions** as three independent controls: Browsing, Downloads, and Uploads. Each accepts Requires approval (`ask`), Always allow (`allow`), or Block (`block`). The durable `browserPermissions` object uses `browsing`, `downloads`, and `uploads`; an absent object inherits the saved `navigationPolicy`, `downloadPolicy`, and `uploadPolicy`. Established defaults remain `ask` for all three, and invalid members normalize to `ask`. A one-time approval never changes these settings. Normal actions, reads, and screenshots use Browsing; file selection uses Uploads; Chromium download events use Downloads independently of the triggering click. No site configuration is required.

The optional `Config.browserPermissions` supplies composition defaults when no saved value exists, including deployments without a settings provider. Detaching an attached provider disables browser control until its replacement supplies settings.

The `browser-electron` namespace owns durable controls for agent access (`controlEnabled`, default `true`); user-opened URL routing (`webDestination` and `localDestination`, both `hydra`); annotation screenshots (`annotationScreenshots`, `include`); download location and prompting (`downloadDirectory`, `''`, and `askWhereToSave`, `false`); navigation, download, upload, and model-history policies (all `ask`); and the elevated Full CDP opt-in (`fullCdpAccess`, `false`). Every decision policy accepts only `allow`, `ask`, or `block`, and native-relevant changes are pushed to every active Electron controller.

The desktop routes absolute HTTP(S) links opened by its trusted renderer rather than letting them replace the app. Non-loopback links use `webDestination`; `localhost`, IPv6 loopback, and `127.0.0.0/8` links use `localDestination`. The system choice removes URL credentials and delegates to the OS browser, while the Hydra harness choice opens a tab under user control and reveals the Browser panel. Model-facing `browser_navigate` remains an agent-controlled browser action and does not use these user-link destination choices.

Quick annotate produces bounded URL, title, element-index, and HTML-preview text. Interactive Annotate is enabled only on HTTP(S) pages, exposes an accessible status tip and Escape cancellation, and produces the same element annotation for a click or short drag, or bounded URL, title, and viewport-rectangle text for a dragged region. `annotationScreenshots` may also include, ask through a native prompt for, or never include a screenshot of the selected element or region; accepted captures are bounded PNGs and enter the active composer paired with the text annotation. Missing geometry, a failed or oversized capture, a tab switch, or a navigation race degrades safely to text-only or drops stale evidence.

Browsing reads and actions within one active logged tool call share its approval, which names the requested tool. A completed call, a new invocation reusing its model call id, or an unlogged direct call requires a fresh decision. Settings and cancellation are checked on every operation. Upload, sensitive-history, navigation, and Full CDP approvals keep their separate scope. Background `currentPage` reads without a call id fail under Browsing `ask` without opening a dialog.

`historyAccessPolicy` governs only model-facing `browser_history_search`, not the user's Settings history manager. `allow` returns at most 20 title/URL matches from the bounded app-owned ledger, `block` denies before Electron is acquired or started, and `ask` requires an `allowed-once` Host approval bound to the query and tool call before Electron is acquired or started; an unavailable approval service fails closed.

Full CDP is effective only when the deployment's `allowFullCdpAccess` ceiling and the user's disabled-by-default `fullCdpAccess` opt-in both allow it. The desktop requires a native risk confirmation before persisting the opt-in, and every command or event read still requires a fresh `allowed-once` Host approval bound to the controlled tab, HTTP(S) origin, and requested operation. Electron rechecks the target before execution, excludes cross-target CDP domains, and bounds request and response data.

Electron persists its bounded management state in `browser-management.json`: at most 1,000 navigation-history entries, 500 download-ledger entries, and 500 exact-origin site overrides. A site override stores top-level navigation `access` and camera/microphone `media` decisions as `allow` or `block`; it does not override download/upload policy or filter subresources. Removing a history or download entry removes only its app-owned ledger row, never an open tab's navigation history or a downloaded file.

Clearing browser data accepts `all` (the default for older callers), `history`, `site-data`, `cache`, or `downloads`. The selected scope clears Chromium data where applicable, clears every open tab's navigation history for `all` or `history`, and updates the matching app-owned history/download ledger. It deliberately retains durable Browser settings, site overrides, downloaded files, and the encrypted autofill vault. Desktop Settings exposes password-free login metadata and allowlisted contact fields only when Electron secure storage and the current preload management methods are available; saved passwords never return to the renderer. Older preloads and unavailable or failed secure storage keep both managers disabled and fail closed.

## Layout

```
electron-app/main.cjs         window + chrome/page WebContentsViews + NDJSON loop over fd 0
electron-app/chrome.html      static tab strip, omnibox, and agent status HUD
electron-app/chrome-preload.cjs sandboxed chrome IPC wiring
electron-app/preload.entry.js source of the preload bundle
electron-app/preload.cjs      committed build output — what Electron actually loads
third-party/browseragent/       locally owned BrowserAgent source copied from PageAgent
vite.preload.config.js        bundles the local runtime and preload into one CJS file
src/                          the Node half: service, child process, types
```

`electron-app/*` runs in Electron, not in the harness's Node process, and is published as-is rather than built by tsdown.

In standalone use, `BrowserSessionService` talks to its Electron child in NDJSON over stdin/stdout — one JSON object per line, `{id, method, args}` out and `{id, ok, result|error}` back. No port is involved, and the channel dies with the process; `main.cjs` therefore sends diagnostics to stderr because stdout is the protocol. The desktop shell instead hosts the same controller in its Electron main process and exposes only narrow, validated preload/IPC operations for configuration and browser management.

## BrowserAgent source

The simulator cursor uses DOM APIs to construct its SVG indicator so pages enforcing Trusted Types can initialize the browser controller and accept form input. The [Trusted Types decision](../../../.agents/notes/implemented/bug-fix/2026-09-26-trusted-types-browser-login.md) owns the rationale.

`pnpm install` links the private `@hydraharness/harness-browseragent-core`, `@hydraharness/harness-browseragent-llms`, and `@hydraharness/harness-browseragent-page-controller` packages from the tracked [`third-party/browseragent`](third-party/browseragent) source. No submodule or external checkout is required. The source retains its upstream MIT license and attribution in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).

## Rebuilding the preload

`electron-app/preload.cjs` is committed. Regenerate it when the local BrowserAgent source or `preload.entry.js` changes:

```
pnpm --filter @hydraharness/harness-browser-electron run build:preload
```

The BrowserAgent source already contains Hydra's cursor and mask changes, so the build has no external checkout or patch overlay step.

## Installing the Electron binary behind a proxy

`electron` is an `optionalDependency`: without it the plugin still loads and every call fails with `BROWSER_UNAVAILABLE`, and the rest of the harness is unaffected. Its postinstall downloads a ~200 MB binary through `@electron/get`, which uses undici's `fetch` and therefore **ignores npm's `proxy` / `https-proxy` settings**. Behind a corporate proxy the download needs the environment variables:

```
HTTPS_PROXY=http://localhost:3128 HTTP_PROXY=http://localhost:3128 \
  node node_modules/.pnpm/electron@43.4.1/node_modules/electron/install.js
```

The postinstall also needs `electron: true` under `allowBuilds` in `pnpm-workspace.yaml`; `strictDepBuilds` blocks it otherwise.

## Security

The controlled view runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload never calls `contextBridge`, so `ipcRenderer` never leaves module scope and a hostile document has no handle on the control channel. The window is headed by default: the user watches what the agent does.

**Agent-controlled navigation checks every new top-level destination.** Direct tool/tab loads and the configured home page check before `loadURL`; popups check before adoption; and Chromium events cover page links and redirects. An exact-origin site block takes precedence over same-origin access and vetoes agent Back, Forward, and Reload; otherwise same-origin HTTP(S) navigation proceeds automatically, a cross-origin destination uses its exact-origin override or the default navigation policy, and non-HTTP(S) destinations fail closed. Native user browsing does not use these agent navigation restrictions. The `ask` policy presents Allow once, Always allow, and Block in the owning chat through `ctx.userQuestions`. Electron holds the main-frame network request until the answer arrives, preserving POST bodies and redirects. Missing answerers, skipped or custom answers, owner disconnection, action cancellation, and document replacement deny the pending request. Browser action deadlines pause during this human wait. Camera and microphone requests use the same chat path.

**Downloads are decided before Chromium writes them.** The default download policy can allow, ask, or block; accepted downloads receive a unique target path under the configured or system Downloads directory, and `askWhereToSave` opens the native save dialog. Only camera and microphone requests can be granted through an exact-origin media override or chat answer; blocking media never grants site access and reloads matching documents, including frames, before the change returns. Every other permission, device-permission, and display-capture request fails closed.

**The profile carries real SSO cookies.** `userDataDir` defaults to `<harness-home>/browser-profile` and persists, which is the point — logging in once should survive the session. Set `persistSessionCookies: true` when the profile must also retain otherwise session-only SSO cookies: Hydra harness promotes them into Chromium's encrypted cookie store for 30 days and flushes the store before a harness-owned exit. It also means a prompt-injected page can steer the agent into acting as the signed-in user against any site that profile is authenticated to. This is the same class of risk as the deferred SSRF protection on `web_fetch` ([web capability seam](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md#deferred-work)): do not enable the embedded browser where an untrusted page can be reached with a profile authenticated to sensitive internal systems. Screenshot capture refuses Browser chrome, background tabs, and non-HTTP(S) pages, but it can still record sensitive pixels visible in the selected signed-in page.

Set `homeUrl` only in the user's profile patch when a deployment has one trusted default site.

**File selection and drops are fail-closed.** File drops validate and approve each file through the same Host Uploads policy, then bind the drop to the approved tab and HTTP(S) origin. `upload_file` accepts only an absolute, readable regular-file path, including a task-created artifact. `BrowserSessionService` enforces the Host-owned upload policy by allowing, rejecting, or requesting approval bound to the exact file, current HTTP(S) origin, tab, input index, and tool call. The preload lists HTML file inputs even when a site hides the chooser; disconnected and disabled inputs cannot receive files. Electron verifies the same tab and origin before and after resolving the indexed HTML `<input type="file">`, then selects the file through Chromium's DOM protocol without page JavaScript. File selection may immediately trigger a website upload.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt and no tool; `@hydraharness/harness-tool-browser` owns the visible schemas, the accessibility-snapshot prompt section, and the result text.

#### Token effect

None directly. A page's accessibility snapshot stays process-local until a consumer returns a bounded result.

#### KV Cache effect

No direct invalidation; the named consumer owns request-prefix changes.

## Known Limitations and Deferred Work

- Playwright actions use the controlled tab debugger; the preload pointer fallback serves explicit PageAgent actions. Alert, confirm, and prompt dialogs are handled through CDP.
- Console and network diagnostics retain at most 1,000 CDP events or 4 MiB per tab, reset on navigation. Individual records are capped at 64 KiB; response bodies can expire from Chromium storage. Raw CDP commands are detached at navigation so their enabled domains do not cross an approved origin.

An ask-policy agent browser action or download requires an open owning turn; native user navigation works without a chat owner. Media requests use the connected chat's question composer. Annotation-screenshot and elevated-risk settings prompts use native dialogs.

- Screenshot control supports viewport coordinates, full-page capture, and CSS-pixel clips; iframe selectors are supported for explicit named or ref actions, while visual iframe discovery remains unavailable.
- `execute_javascript` is experimental and host-gated by `experimentalScriptExecution`; it runs in PageAgent's isolated document world. `browser_execute_page_javascript` is also experimental and uses Electron's page world when page-defined globals are required.
- File upload supports an observed HTML file input, including a hidden chooser input, and drag/drop targets through `browser_drop`; a proxy button without either surface remains unsupported.
- Website media, geolocation, and notification requests can be approved through the owning chat; device permissions and display capture remain fail-closed. Download history can open completed files, but active-download cancel/retry controls are still deferred.
- Sessions are process-local: a harness restart loses the window, though the profile keeps the login.
- One agent owns one Chromium profile and window. Parallelism is across that window's isolated tabs; use separate agents when work requires independent browser profiles or windows.

The embedded controller uses `playwright-core` directly through an in-process CDP transport attached to each Electron tab. Playwright supplies actionability and locator execution for clicks, hover, drag, text entry, selection, form filling, and find operations. Hydra still owns navigation and permission policy, tab lifecycle, accessibility snapshots, upload handling, and approval-gated raw CDP. The adapter does not open a TCP debugging port or start a Playwright MCP server.

Desktop ownership also supports a WSL Host through the native-command desktop bridge. Browser messages travel over the owned child pipes with a launch token, and Electron converts filesystem paths between the selected distro and native Windows. Changing the active trusted window reattaches native views without ending browser sessions.
