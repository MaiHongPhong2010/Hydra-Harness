# Live notifications

The `notifications` settings namespace controls live turn completion, pending questions, display-permission prompts, and sound. Completion defaults to Background. API proxy emits `notifications/requested` only when a new turn ends or a new question is requested; transcript reload does not emit it. Connected Web windows use browser permission. Desktop windows share native delivery and deduplicate stable notification ids. Clicking a question opens its chat.

## Model Experience

None, as live notification delivery adds no model input or transcript content.

#### KV Cache effect

None; notification policies do not alter model requests.

## Known Limitations and Deferred Work

- Web delivery requires a connected page and browser display permission. Desktop delivery remains subject to OS notification settings.
