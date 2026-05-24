# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

SimpleSiteBlock is a Manifest V3 browser extension. It blocks top-level
HTTP(S) navigations using hosts-file lists, a small host-only subset of Adblock
syntax, and custom rules entered on the options page.

The project uses plain browser ES modules. There is no bundler, transpiler, or
framework layer, so keep imports browser-compatible and avoid adding build-time
dependencies unless the task explicitly calls for it.

## Key Paths

- `manifest/chrome.json` and `manifest/firefox.json`: extension entry points,
  permissions, and browser-specific manifest data.
- `src/background/service_worker.js`: navigation handling, state cache, alarms,
  and background event wiring.
- `src/background/engine.js`: pure host matching, hydration, serialization, and
  index combination.
- `src/background/lists.js`: list fetching, validation, parsing, compilation,
  update scheduling, list metadata edits, and pending rebuild state.
- `src/background/storage.js`: typed defaults and wrappers around extension
  local storage.
- `src/background/backup.js`: settings export/import validation and rebuild
  behavior.
- `src/background/parser/hosts.js`: hosts-file parser.
- `src/background/parser/adblock.js`: supported host-only Adblock parser.
- `src/options/`: options UI, accountability lock UI, list management,
  import/export, and diagnostics.
- `src/popup/`: extension action popup.
- `src/blocked/`: blocked-page UI.
- `test/`: Node tests for pure modules and mocked browser extension APIs.

## Commands

Run all tests:

```sh
npm test
```

Build the browser extensions manually:

```sh
npm run build
```

Load the Chrome extension manually:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `dist/chrome`.

Load the Firefox extension manually:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose Load Temporary Add-on.
3. Select `dist/firefox/manifest.json`.

## Rule Model

- Hosts-file entries are exact host blocks. `0.0.0.0 example.com` blocks
  `example.com`, not `www.example.com`.
- Plain Adblock/custom rule domains are exact host rules. `example.com` blocks
  `example.com`, not subdomains.
- `||example.com^` is a subtree host rule. It blocks `example.com` and any
  subdomain.
- `@@example.com` and `@@||example.com^` are exact and subtree allow rules.
- Regex rules, path rules, wildcard rules, and URL-anchored rules are not
  supported. Examples such as `/ads/`, `*.example.com`,
  `|https://example.com/path*`, and `example.com/banner` should be skipped with
  warnings rather than compiled.
- The engine is host-only. Do not reintroduce URL regex matching unless the task
  explicitly asks for it and tests cover the changed behavior.

## Development Notes

- Prefer small, direct ES module changes. Keep code browser-native.
- Use extension local storage through `src/background/storage.js` helpers.
- Parser and engine code should remain pure where practical and covered by
  `node --test`.
- The background worker caches hydrated state in memory. Storage changes should
  invalidate that cache when they can affect blocking behavior.
- `compiledIndex` is the source used for blocking. If a change affects effective
  rules, make sure the index is rebuilt immediately or that deferred rebuild
  behavior is deliberate and clearly surfaced in the UI.
- `pendingRebuild` means list metadata/raw-list changes exist that may not be
  reflected in `compiledIndex` until an update/rebuild path runs.
- Adding a list, removing a list, enabling/disabling a list, changing a list's
  format, or editing a list URL should leave the UI and `compiledIndex`
  relationship clear. URL edits must clear cached raw text and validators for
  that list.
- Name-only list edits should not clear cached raw text or force a rebuild.
- The global list update alarm is named `update:index`. Be careful when changing
  alarm names because old extension installs may have persisted alarms.
- List fetches reject obvious HTML and enforce response size limits.
- Settings exports intentionally omit derived/cache data such as
  `compiledIndex`, `pendingRebuild`, and raw list bodies.
- The password lock is a personal accountability gate on the options page, not a
  security boundary. Passwords are stored as plaintext settings when enabled.

## Testing Expectations

- Run `npm test` before handing off code changes.
- Add or update tests for parser behavior, matching behavior, settings
  import/export, alarm reconciliation, and list lifecycle changes.
- Mock browser extension APIs narrowly in tests; keep mocks close to the behavior
  being asserted.
- For UI-only changes, inspect the options page manually by loading the unpacked
  extension when feasible.
- If local browser verification is not feasible, say so and describe what was
  covered by automated tests.

## Style

- Keep files ASCII unless an existing file or user-facing copy clearly requires
  Unicode.
- Follow the existing concise style: small functions, direct conditionals, and
  minimal comments.
- Avoid broad refactors while fixing a narrow behavior.
- Do not introduce a bundler, framework, formatter, or dependency without a
  clear project need.
- Keep UI copy honest about scope: this is blocking/accountability tooling, not
  a hard security product.

## Review Checklist

- Does the change affect what URLs are blocked or allowed?
- Does the parser still skip unsupported regex/path/wildcard rules cleanly?
- Does a storage/import change preserve the intended settings shape?
- Does a list enable/disable/remove/update/edit path leave `compiledIndex`,
  cached raw list text, and the UI in a consistent state?
- Do alarms avoid duplicate or stale schedules after upgrades?
- Are parser changes covered by tests for valid, invalid, and skipped input?
- Are extension permission changes reflected in both browser manifests and
  justified?
