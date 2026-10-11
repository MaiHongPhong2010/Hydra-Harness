# Optional plugin policy

The `optional-plugins.enabled` preference defaults to On and preserves individual enablement records. Consumers acquire a completion lease before starting optional work. Off rejects new work immediately. Lifetime owners await `drain()` before removing contributions; enabling plugins again cancels pending removal. Required plugins remain available independently of the restart classification `pluginType`.


## Model Experience

Indirectly, through the owning optional plugins whose contributions and new invocations this policy controls.

#### KV Cache effect

Disabling optional tools can change the next request's tool context; each owning plugin controls its rendered contribution.

## Known Limitations and Deferred Work

- Work admitted before disablement finishes under its existing lease. Turning the common policy back on preserves individual choices.
