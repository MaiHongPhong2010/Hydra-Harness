# @hydraharness/harness-client-hmr

Live contribution updates and hot reload for script-loaded client plugins. The web bundle mounts the row unconditionally; graph updates apply in normal runs, while `pnpm run dev:web` also supplies bundle rebuilds.

The browser half subscribes to the system SSE channel (`GET /plugins/events`) and reloads one plugin per `rebuilt` frame through a serialized queue. The sequence per frame — `invalidate`, `prefetch` (load and register the new bundle while the old fiber still serves), `registry.delete` (before the fiber: a bare fiber dispose trips the vendored Loader's self-dispose branch, which would mark the entry disabled), drain the old fiber, delete `entry.fiber`, remove owned `<style data-plugin>` tags, `entry.refresh()` re-imports and remounts, `fiber.await()` rethrows startup failures loud. Dependents reload through cordis itself: a fiber's activation epoch strings its service providers' uids, so replacing a provider's fiber cascades every dependent with zero client-side graph analysis. The node half detects rebuilds with one interval that stat-polls each graph bundle from a synchronous baseline, immediately re-hashes after adding a row, retains missing rows as dirty, and broadcasts only real rev changes; any tsdown watch process producing the bundle therefore triggers HMR with no builder→host channel.

Graph frames reconcile live Host contribution changes through the same queue. Removed entries unload before added entries arrive and activate; required product rows remain mounted. Enabling optional plugins after a disabled startup loads their bundles from the accepted graph without restarting the page.

## Model Experience

None, as the reload driver is browser-side machinery; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Reload is coarse by design** — a fresh fiber and fresh components; React state inside the reloaded plugin is lost while the data layer (connection/runtime fibers, Session objects) is untouched. react-refresh-grade state preservation conflicts with "re-executing the bundle re-runs the factory" and is deliberately out.
- **No failure rollback** — a reload that fails leaves the entry FAILED and visible in the loader status projection; the previous bundle is not restored automatically.
