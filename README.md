# Research Trail

Research Trail is a local-first Chrome extension for preserving research context. It remembers how tabs relate to one another and lets you collect selected evidence with its source.

## What it does

- Records a durable parent/child trail when links open in new tabs.
- Captures the clicked link text and a short excerpt from the surrounding page when the match is reliable.
- Shows the active tab's parent, siblings, and children in a Chrome Side Panel.
- Saves highlighted text through **Add to Research Cart** in the page context menu.
- Keeps tab notes and evidence notes locally, with no account, server, sync, analytics, or AI.

Research Trail deliberately prefers missing click context over attaching the wrong excerpt. A tab still retains its parent relationship when link matching is ambiguous.

## Develop

Requirements: Node.js 22+, pnpm, and Chrome 114 or newer.

```bash
pnpm install
pnpm dev
```

For a production build:

```bash
pnpm test
pnpm typecheck
pnpm build
```

The unpacked extension is written to `dist/`.

## Load in Chrome

1. Run `pnpm build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this project's `dist/` folder.
5. Click the Research Trail toolbar action to open the Side Panel.

After installing or reloading the extension, reload any already-open research page before testing link-text capture. Chrome injects static content scripts on the next navigation; tab tracking and Research Cart selection saving work immediately.

## Manual acceptance check

1. Open a normal HTTP(S) page, then open two links in new tabs using Command/Ctrl-click, middle-click, `_blank`, or the native link context menu.
2. Confirm each child shows the correct parent and sibling. Return to the parent and confirm both children appear.
3. Confirm a distinctive link shows its link text and a short surrounding excerpt. Ambiguous matches may intentionally show parent-only context.
4. Navigate within a child tab, then close and reopen it from Research Trail. Its stable relationship should remain.
5. Highlight text, right-click, and choose **Add to Research Cart**. Verify its text, title, and source, then edit its note.
6. Verify **Open source** focuses an exact live source URL or opens it in a new tab.
7. Close/reopen the Side Panel and restart Chrome; saved evidence and context records should remain.
8. Clear tab history and verify Research Cart items remain while current tabs are reseeded as roots.

## Architecture

- `src/core.ts` contains browser-independent graph, matching, text, and reconciliation logic.
- `src/background/` is the authoritative coordinator and the only writer to extension storage.
- `src/content.ts` passively observes link activations; it never modifies page content.
- `src/sidepanel/` renders view models and sends typed commands.
- `src/platform/chrome.ts` is the only direct Chrome namespace boundary.

Durable contexts and cart items use `storage.local`. Live browser-tab bindings and short-lived link candidates use `storage.session`, because numeric tab IDs are not durable identities. The service worker treats all in-memory state as disposable.

## Permissions

- `tabs`: read tracked tab URLs/titles and focus or reopen sources.
- `storage`: persist local contexts and evidence.
- `contextMenus`: expose **Add to Research Cart** for selected text.
- `sidePanel`: host the extension interface.
- HTTP/HTTPS page access: observe link activations and capture nearby readable text.

Incognito, file URLs, browser-internal pages, and non-HTTP(S) sources are intentionally ignored.

## Safari portability

Core models and behavior do not depend on the Side Panel or Chrome namespace. A Safari version will need a Safari-specific adapter, manifest/package, and popup or extension-page host, while reusing the core, storage contracts, content capture, and most UI code.

## V1 limits

There are no named projects, cloud sync, collaboration, search, import/export, automated fact checking, AI features, graph visualization, or store publishing in this version. Restored tabs reconnect only when URL/title matching is unique; ambiguous duplicates start new roots.
