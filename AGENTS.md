# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

SimpleSiteBlock is a Manifest V3 browser extension. It blocks top-level
HTTP(S) navigations using hosts-file lists, a small host-only subset of Adblock
syntax, and custom rules entered on the options page.

The project uses plain browser ES modules. There is no bundler, transpiler, or
framework layer, so keep imports browser-compatible and avoid adding build-time
dependencies unless the task explicitly calls for it.

## Status: rewritten to declarativeNetRequest

The v1 matching engine (a packed-string host index evaluated in the service
worker on `webNavigation.onBeforeNavigate`) has been removed. Blocking now runs
on Chrome's `declarativeNetRequest` (DNR): parsed lists and custom rules are
normalized, packed into dynamic rules, and applied by the browser. See `DNR.md`
for the design.

Blocking is rebuilt and reapplied by `rebuildRules()` in `lists.js` (combine all
enabled lists' cached bodies + custom rules → normalize → pack → swap the full
dynamic rule set). It runs on Update All (after fetch), on saving custom rules,
and on settings import.

Known gap: list CRUD (add/remove/enable/disable/edit) only sets `pendingRebuild`
and does **not** reapply rules immediately — changes take effect on the next
Update All. So a removed or disabled list keeps blocking until then.
`pendingRebuild` means an enabled list has no cached body yet (needs a fetch
before it can contribute rules), or a CRUD edit is awaiting Update All.

## Key Paths

- `manifest/chrome.json`: extension entry point, permissions, and manifest data.
  This is a Chrome-only extension.
- `src/background/service_worker.js`: alarms, list-update/import message
  handlers, and background event wiring.
- `src/background/lists.js`: list fetching, validation, parsing, update
  scheduling, list metadata edits, and pending rebuild state.
- `src/background/storage.js`: typed defaults and wrappers around extension
  local storage.
- `src/background/backup.js`: settings export/import validation.
- `src/background/parser/hosts.js`: hosts-file parser.
- `src/background/parser/adblock.js`: supported host-only Adblock parser.
- `src/options/`: options UI, accountability lock UI, list management, and
  import/export.
- `src/popup/`: extension action popup.
- `src/blocked/`: blocked-page UI.
- `test/`: Node tests for pure modules and mocked browser extension APIs.

## Commands

Run all tests:

```sh
npm test
```

Build the extension manually:

```sh
npm run build
```

Load the Chrome extension manually:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `dist/chrome`.

## Rule Model

- Matching is subtree-only: every block/allow entry matches a host **and all of
  its subdomains**. There is no exact-host (apex-only) matching. See DNR.md
  "Matching model" for why.
- Hosts-file entries (`0.0.0.0 example.com`), plain domains (`example.com`), and
  `||example.com^` all parse to the same subtree block of `example.com`.
- `@@example.com` and `@@||example.com^` parse to subtree allow rules.
- Hosts are keyed as written (validated, lowercased, IDN→ASCII), not reduced to
  their registrable domain.
- The parsers emit a flat `{ block, allow, warnings }` shape (Sets of hosts).
- Regex rules, path rules, wildcard rules, and URL-anchored rules are not
  supported. Examples such as `/ads/`, `*.example.com`,
  `|https://example.com/path*`, and `example.com/banner` are skipped with
  warnings.
- This is host-only. Do not reintroduce URL regex matching unless the task
  explicitly asks for it and tests cover the changed behavior.

## Development Notes

- Prefer small, direct ES module changes. Keep code browser-native.
- Use extension local storage through `src/background/storage.js` helpers.
- Parser code should remain pure where practical and covered by `node --test`.
- `pendingRebuild` means list metadata/raw-list changes are not yet reflected in
  active blocking rules. `rebuildRules()` clears it (see Status for what triggers
  a rebuild and the CRUD gap).
- Adding, removing, enabling/disabling, reformatting, or editing a list's URL
  sets `pendingRebuild`. URL edits must also clear cached raw text and
  validators (etag/last-modified) for that list.
- Name-only list edits should not clear cached raw text or set `pendingRebuild`.
- The global list update alarm is named `update:index`. Be careful when changing
  alarm names because old extension installs may have persisted alarms.
- List fetches reject obvious HTML and enforce response size limits.
- Settings exports intentionally omit derived/cache data such as `pendingRebuild`
  and raw list bodies. Imports must still reject a `compiledIndex` field for
  backward compatibility with v1 exports.
- The password lock is a personal accountability gate on the options page, not a
  security boundary. Passwords are stored as plaintext settings when enabled.

## Testing Expectations

- Run `npm test` before handing off code changes.
- Add or update tests for parser behavior, settings import/export, alarm
  reconciliation, and list lifecycle changes.
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
- Does a list enable/disable/remove/update/edit path leave `pendingRebuild`,
  cached raw list text, and the UI in a consistent state?
- Do alarms avoid duplicate or stale schedules after upgrades?
- Are parser changes covered by tests for valid, invalid, and skipped input?
- Are extension permission changes reflected in `manifest/chrome.json` and
  justified?
