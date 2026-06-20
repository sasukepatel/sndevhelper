# SN Dev Helper — Claude Code project notes

A Manifest V3 Chrome extension of developer utilities for ServiceNow, in the
spirit of snUtils. Plain JS, zero runtime dependencies, zero build step.

## Run / debug loop
- Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → this folder.
- After editing, click the **reload** icon on the extension card. For
  content-script changes, also refresh the ServiceNow tab.
- Package for the Chrome Web Store: `bash package.sh` (produces a clean zip with
  only the files Chrome needs).

## Architecture (read before changing message flow)
ServiceNow's classic UI runs the real app inside an iframe named **`gsft_main`**;
the toolbar/shell is the top frame. The form DOM (labels, fields) lives in
`gsft_main`. Two consequences drive the whole design:

1. **Two JS worlds.** A content script runs in an *isolated* world: it can
   read/modify the DOM but CANNOT see page globals (`g_form`, `g_user`, `g_ck`).
   To read those we call `chrome.scripting.executeScript({ world: "MAIN" })`
   from `popup.js`. DOM-only work stays in `content.js`.
2. **Frames.** Content scripts and `executeScript` run with `allFrames`, then we
   pick the frame that actually returned SN context (the one with `g_form`).

### Message flow
- popup → content script: `chrome.tabs.sendMessage` (`TOGGLE_FIELD_NAMES`,
  `TOGGLE_TRANSLATIONS`). Delivered to all frames; `gsft_main` does the work.
- content script → service worker: `chrome.runtime.sendMessage` (`OPEN_URL`),
  because content scripts can't call `chrome.tabs.create`.
- keyboard command (`background.js`) → content script for the field-name toggle.

### REST from the content script
`content.js` calls the Table API (`/api/now/table/...`) directly. This works
because `gsft_main` is **same-origin** with the instance, so the session cookie
authenticates the GET. Cross-origin fetches would NOT work from a content
script under MV3 — they'd have to move to the service worker. Reads here assume
GET doesn't require the CSRF token; if an instance enforces it, calls throw and
the caller falls back gracefully.

## Files
- `manifest.json` — MV3 config, permissions, content scripts, command.
- `content.js` — isolated world: field-name badges, translation icons,
  dictionary-inheritance resolution, Table API helper (`snGet`).
- `popup.js` / `popup.html` / `popup.css` — popup UI: instance info, quick table
  open, dev links, copy sys_id, toggles.
- `background.js` — service worker: keyboard command + `OPEN_URL` handler.

## Feature notes
- **Translation icons** add two icons per label:
  - Globe → `sys_documentation` (label/plural/hint, per `table.field`). The
    defining table is resolved by walking `sys_db_object.super_class` and
    checking `sys_dictionary`, so inherited fields resolve correctly.
  - "Languages" glyph → `sys_translated_text` (per-record VALUE translations),
    filtered by `documentkey=<record sys_id>^fieldname=<field>` when a record is
    open, else `tablename^fieldname`.
- **Field-name badges** parse the classic label id format `label.<table>.<field>`.

## Conventions & constraints
- Keep it dependency-free vanilla JS. No bundler, no framework in extension
  pages: MV3's page CSP forbids `unsafe-eval`, so **AngularJS will not run in the
  popup** (its expression compiler uses the Function constructor). Content
  scripts may still use Service Portal's own Angular on the page.
- Do NOT create a top-level file or folder whose name starts with `_` — Chrome
  reserves those and will refuse to load the extension. (`CLAUDE.md`, `.claude/`,
  `.git/` are fine; Chrome ignores them.)
- Toggles are manual and don't re-apply after a form re-renders. A
  `MutationObserver` is the planned fix.

## Roadmap
Background Script runner, update set switcher, impersonation, Table API record
search, GlideRecord snippet generator, per-environment favicon badge, and a
`MutationObserver` so toggles survive partial form reloads.
