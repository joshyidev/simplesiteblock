# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

SimpleSiteBlock is a Manifest V3 Chrome extension. It blocks top-level HTTP(S)
navigations using hosts-file lists, a supported subset of Adblock syntax, and
custom rules entered on the options page.

The project uses plain browser ES modules. There is no bundler, transpiler, or
framework layer, so keep imports browser-compatible and avoid adding build-time
dependencies unless the task explicitly calls for it.

## Key Paths

- `manifest.json`: extension entry points and Chrome permissions.
- `src/background/service_worker.js`: navigation handling, state cache, alarms.
- `src/background/engine.js`: pure matching, hydration, serialization.
- `src/background/lists.js`: list fetching, validation, parsing, compilation,
  update scheduling, and pending rebuild state.
- `src/background/storage.js`: typed defaults and wrappers around
  `chrome.storage.local`.
- `src/background/crypto.js`: password hashing and verification for the options lock.
- `src/background/parser/hosts.js`: hosts-file parser.
- `src/background/parser/adblock.js`: supported Adblock parser.
- `src/options/`: options UI, lock UI, list management, diagnostics.
- `src/popup/`: extension action popup.
- `src/blocked/`: blocked-page UI.
- `test/`: Node tests for pure modules and mocked Chrome APIs.

## Commands

Run all tests:

```sh
npm test
```

Load the extension manually:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this repository folder.

## Development Notes

- Prefer small, direct ES module changes. Keep code browser-native.
- Use `chrome.storage.local` through `src/background/storage.js` helpers.
- Parser and engine code should remain pure where practical and covered by
  `node --test`.
- The background worker caches hydrated state in memory. Storage changes should
  invalidate that cache when they can affect blocking behavior.
- `compiledIndex` is the source used for blocking. If a change affects effective
  rules, make sure the index is rebuilt immediately or that deferred rebuild
  behavior is deliberate and clearly surfaced in the UI.
- `pendingRebuild` means list metadata/raw-list changes exist that may not be
  reflected in `compiledIndex` until an update/rebuild path runs.
- The global list update alarm is named `update:index`. Be careful when changing
  alarm names because old extension installs may have persisted alarms.
- List fetches reject obvious HTML and enforce response size limits.
- Hosts-file entries are exact host blocks. Adblock `||example.com^` style rules
  are subtree rules.
- The password lock is a soft options-page gate, not a hard security boundary.

## Testing Expectations

- Run `npm test` before handing off code changes.
- Add or update tests for parser behavior, matching behavior, storage migrations,
  alarm reconciliation, and list lifecycle changes.
- Mock Chrome APIs narrowly in tests; keep mocks close to the behavior being
  asserted.
- For UI-only changes, inspect the options page manually by loading the unpacked
  extension when feasible.

## Style

- Keep files ASCII unless an existing file or user-facing copy clearly requires
  Unicode.
- Follow the existing concise style: small functions, direct conditionals, and
  minimal comments.
- Avoid broad refactors while fixing a narrow behavior.
- Do not introduce a bundler, framework, formatter, or dependency without a
  clear project need.

## Review Checklist

- Does the change affect what URLs are blocked or allowed?
- Does storage migration preserve existing users' settings and lists?
- Does a list enable/disable/remove/update path leave `compiledIndex`
  consistent with the UI?
- Do alarms avoid duplicate or stale schedules after upgrades?
- Are parser changes covered by tests for valid, invalid, and skipped input?
- Are extension permission changes reflected in `manifest.json` and justified?
