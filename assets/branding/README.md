# Hydra harness artwork

[`hydra.png`](hydra.png) is the original supplied transparent artwork. The product name is **Hydra harness**. DeepSeek remains the external provider name; upstream trademark guidance is retained in [BRAND_GUIDELINES.md](../../BRAND_GUIDELINES.md).

[`hydra-hover.gif`](hydra-hover.gif) is the supplied transparent animation. Hovering a product logo plays its 60 frames over two seconds; leaving restores the still image. Pointer hover explicitly requests playback even when the OS prefers reduced motion; leaving always stops it. Touch-only clients keep the still image. The generator preserves frame timing and transparency in a 128px animated WebP for the small UI marks. Native icons and attribution badges remain static.

Regenerate the client logo files, app/site `hydra.png`, website wordmark, desktop/browser icons, and attribution badge from this source:

```sh
uv run --with pillow python scripts/gen-brand-assets.py
```

The generator crops transparent padding and scales the supplied artwork without changing its colors. React consumers share `HydraLogo` through `@hydraharness/harness-client-ui-primitives`; the PNG and hover WebP travel as files next to that module. Electron packages publish their icon assets. Rebuild the apps and documentation site after regeneration.

On Windows, Desktop main and popout windows share the `org.hydraharness.desktop.window` AppUserModelID and set the taskbar icon to the published `hydra.ico`. The window ID is separate from Electron's notification registration, whose generated shortcut uses the executable's icon.
