# Agent Note: Desktop Files panel IDE workspace management and coding controls

Status: implemented

## Problem

Developers using the desktop app's right-side panel need focused, IDE-native coding workflows for inspecting and editing workspace files without switching away to an external editor. A flat, uncollapsible file list cannot show currently open editing buffers, symbol definitions, or breadcrumbs; navigating across deeply nested files requires repeatedly expanding and collapsing directory trees; and a fixed-width sidebar crowds either the file tree or the code editor canvas.

## Decision

The desktop Files panel adopts a three-pane IDE layout: a resizable sidebar (160px–480px) with a vertical splitter drag handle, a collapsible multi-section navigation explorer, and a coding editor canvas with file tabs, breadcrumbs, and a status bar.

The explorer sidebar organizes file state into three collapsible sections:
1. `OPEN EDITORS`: lists active document tabs with dirty dot indicators, individual tab close buttons, "Save All" (`saveAllFiles`), and "Close All" (`closeAllTabs`).
2. `WORKSPACE FILES`: hierarchical directory tree with color-coded file extension badges (TypeScript, JavaScript, JSON, CSS, HTML, Markdown, Python), substring search filter, inline file/folder creation, refresh, and full context menus for renaming, deleting, copying paths, and revealing on disk.
3. `OUTLINE`: auto-extracts code symbols (functions, classes, interfaces, types, and markdown headings) from the active editor document with click-to-jump line navigation.

The code editor canvas adds breadcrumbs path navigation, an active cursor line gutter, and coding controls:
1. Breadcrumbs display the active file's directory hierarchy with extension icons.
2. Word Wrap toggle (`Alt+Z`) alternates between horizontal scrolling (`wrap="off"`) and soft word wrapping (`wrap="soft"`).
3. Go to Line dialog (`Ctrl+G`) prompts for a line number and jumps the caret and viewport to that position.
4. Diff with disk, Discard changes, Copy file content, Format (`Shift+Alt+F`), and Save (`Ctrl+S`) provide instant code maintenance.
5. The status bar presents line and column coordinates, selection character count, total lines, indentation (`Spaces: 2`), encoding (`UTF-8`), line ending (`LF` or `CRLF`), and language mode.

Single `aria-label="Unsaved changes"` accessibility contract is maintained on the editor title dirty indicator; tab and open editor dirty dots use `aria-hidden="true"` and `title="Unsaved changes"` to prevent screen reader ambiguity.

Save All publishes each file's acknowledged disk version into the latest open-document list. A later failure leaves earlier successes clean and preserves unsaved drafts; edits made during a save remain dirty, and closed tabs remain closed. Rename and move remap descendant editor paths and cached tree paths together. Context-menu creation captures the clicked folder directly. File mutations serialize with saves, formatting, and creation, and ignore results and errors after a Workspace change.

File relocation returns the versions immediately before and after renaming when device, inode, size, and modification time remain unchanged. The editor accepts that new version only if its previous version matches. This accounts for rename-induced change-time updates without accepting an already stale draft. Removing change time from all file versions would weaken ordinary external-edit detection.

## Alternatives considered

**Full Monaco or CodeMirror embedding.** Heavier dependency footprint and complex multi-instance webview lifecycle. The lightweight syntax-overlay textarea preserves native typing, IME composition, system selection, and minimal memory overhead while providing VS Code-grade coding conveniences.

**Single global file tab without open editors list.** Makes working across multiple files cumbersome and requires continually hunting through the file tree to switch between recently opened files.

**Non-resizable sidebar.** A fixed width either compresses long file paths in deep hierarchies or consumes excessive editor space on smaller viewports.

## Consequences

Developers can navigate, edit, outline, and format workspace files directly inside the right panel. Save All can partially succeed; the panel reports the first failure without rolling back completed disk writes. A successful rename, move, or delete clears the file filter so the updated tree is visible. Drafts and editor selection remain transient.

The focused Files operation specs cover context-menu parent selection, renamed and moved descendant drafts, matching relocation versions, partial Save All, newer typing, and stale Workspace failures. The desktop `--smoke-files` scenario also runs inside the normal desktop smoke, exercises the assembled renderer and real filesystem, compares its transcript with [the Files snapshot](../../../../apps/desktop/tests/snapshots/files-operations.expected.json), and checks mutation confinement and saved bytes.
