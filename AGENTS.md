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
normalized, packed into dynamic rules, and applied by the browser.

Blocking is **top-level only** — a `redirect` to the block page on `main_frame`
requests (plus `allow` rules for exceptions). There are no subresource rules, so
a blocked host embedded as an iframe/script in another page is not blocked; this
is a site blocker, not a subresource/ad blocker. Note `redirect` is an "unsafe"
DNR action, capped at 5,000 dynamic rules — at ~1,000 domains packed per rule
that bounds blockable domains at ~5 million (`assertListRedirectBudget` guards
it, reading the cap from
`declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` with a 5,000 fallback).
Only `redirect` is unsafe; `allow` rules are safe and do not count against it.

Rules are applied as **two independent slices** with disjoint dynamic-rule ID
ranges (see `lists.js`):

- **Lists** (`rebuildListRules`, ID base 1, normal priority band): all enabled
  lists' cached bodies → normalize → pack → swap the list slice.
- **Custom rules** (`rebuildCustomRules`, ID base 1,000,000, higher priority
  band): only the custom-rules text → normalize → pack → swap the custom slice.
  Runs on saving custom rules. Never reads list bodies, so it's cheap regardless
  of list size.

`rebuildAll()` runs both and is used on Update All (after fetch) and settings
import. `applyRuleSlice` removes a slice by its actual ID range (queried via
`getDynamicRules`), so it self-heals stale rules from older builds. Custom rules
use a higher priority band so they win over lists — e.g. a custom block entry
overrides a list's allow. Allow still beats redirect within each band.

List CRUD (add/remove/enable/disable/URL edit) reapplies the list slice
immediately via `applyListRules()`, so a removed or disabled list stops blocking
at once and what is applied always matches the current configuration. There is no
pending/deferred state: no `pendingRebuild`, no `appliedSignature`, no "run Update
lists to apply" notice. A list with no cached body simply contributes nothing
until a fetch gives it one. Name-only edits change no rules and deliberately do
not rebuild. The trade is that every toggle reparses all cached bodies; on a
handful of lists that is well under a second, and it removes a whole class of
"applied rules disagree with the config" bugs. Do not reintroduce a deferred
rebuild — it was removed on purpose. List CRUD still does not change the
automatic-update cadence.

Automatic list updates are anchored to the persisted
`lastListUpdateAttemptAt`, not to when Chrome happens to create or restore the
`update:index` alarm. A missing alarm preserves the remaining delay; if the
last attempt is overdue (or absent after install/upgrade), reconciliation keeps
an already-pending alarm or schedules a prompt update. Update All records the
attempt before fetching and `lastListUpdateCompletedAt` after all list fetches
settle, before rebuilding DNR. The options UI reports this as "Lists checked";
`guardCacheVersion` is an internal navigation-guard cache key, not a time at all.
`handleAlarm`
re-records the attempt if a run failed before getting that far, so a broken
update costs one period instead of leaving the schedule permanently overdue —
which would re-arm the alarm at the minimum delay on every worker wake and
refetch every minute.

Startup reconciliation: dynamic rules persist in the browser keyed to the
extension ID, so they can outlive the storage that produced them (an unpacked
reload reuses the path-derived ID; a reset wipes storage but leaves the rule
store). `reconcileRules()` clears **orphaned** rules — list rules present when
`appliedListRuleCount` is 0 (no list build ever committed in this storage), or
custom rules with no backing text — and restores rules that vanished though some
were last applied (`appliedListRuleCount`/`appliedCustomRuleCount` > 0 but the
slice is empty). The rule count, not the block-domain count, is the signal on both
sides, so an allow-only slice — which applies DNR rules but blocks 0 domains — is
still restored. Because every list edit reapplies the slice, applied rules cannot
drift from the configuration by any route other than these two, which is why the
count alone is sufficient. It runs on
`runtime.onInstalled` and `runtime.onStartup` only — **not** on every worker wake
— because applied rules only drift across an install/reload or a browser restart,
and it reads the full ruleset via `getDynamicRules` (kept off the hot path). The
per-wake `initialize()` does only cheap storage work (`ensureDefaults`,
`reconcileAlarms`).

Navigation guard (`navigation_guard.js`): Brave applies DNR `redirect`-to-block-
page rules to top-level navigations unreliably — the navigation can hang
indefinitely (reproducibly when a block page is already open in another tab).
Chrome is fine. A `webNavigation.onBeforeNavigate` listener (registered in **all**
browsers as one unified path) decides whether the URL is blocked and, if so,
redirects the tab with `tabs.update` — a direct navigation, which does not trigger
Brave's bug. On Brave this is the thing that makes blocking reliable; in Chrome
DNR has usually already redirected, so the `tabs.update` is a harmless
re-navigation to the same block page. No flash: the DNR rule still holds the
original request (blocked content never loads), so this only guarantees the block
page commits.

The guard does **not** use `declarativeNetRequest.testMatchOutcome()` — that API
is only available to **unpacked** extensions, so it throws on a Web Store install
and the guard would silently never fire (the bug that made the Brave backstop fail
in production). Instead the guard maintains its own host
matcher: each rebuild persists the same normalized block/allow host sets that
produced the DNR rules (storage keys `guardHostsList`/`guardHostsCustom`), and the
guard subtree-matches the navigation host against them. This means the lists ARE
duplicated in storage (DNR is still the applied source of truth; the host sets are
a parallel cache kept in sync on every rebuild, including reconciliation and
import). Each slice commits its host sets, counts, and cache version in a **single**
storage write (`saveAppliedListSlice`/`saveAppliedCustomSlice`) so a worker death
mid-rebuild cannot leave the guard matching hosts the applied rules no longer
contain. The matcher is held in memory keyed by `guardCacheVersion`, so a
non-blocked navigation costs one cheap storage read at most and the host sets
reload only when the rules change. `guardCacheVersion` is a **fresh
`crypto.randomUUID()` per commit** — never a timestamp, and never derived from the
stored value. Two slices apply back to back so wall-clock stamps can collide in a
millisecond, and `incognito: "split"` gives the regular and incognito workers
separate in-memory `runListOperation` queues over one shared `storage.local`, so a
read-modify-write counter can hand two concurrent commits the same value. Either
collision leaves the guard holding a matcher it believes is current while a
slice's hosts are missing from it. Only inequality is ever tested, so uniqueness
is the entire contract — do not reintroduce ordering. Precedence mirrors the DNR
priority bands: custom allow > custom block > list allow > list block, so `@@`
allow exceptions and custom-over-list overrides resolve identically to DNR.

On a confirmed block the guard always redirects the tab to the block page; DNR
holds the original request so the blocked content never loads.

The listener must be registered synchronously
at worker top level so the event can wake a dormant MV3 worker. Requires the
`webNavigation` permission (not `tabs`: setting a tab URL does not need it).

## Key Paths

- `manifest/chrome.json`: extension entry point, permissions, and manifest data.
  This is a Chrome-only extension.
- `src/background/service_worker.js`: alarms, list-update/import message
  handlers, and background event wiring.
- `src/background/lists.js`: list fetching, validation, parsing, update
  scheduling, list metadata edits, pending rebuild state, and startup rule
  reconciliation.
- `src/background/navigation_guard.js`: Brave-only `onBeforeNavigate` backstop for
  Brave's unreliable DNR top-level redirect (see Status).
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
  its subdomains**. There is no exact-host (apex-only) matching — DNR's
  `requestDomains` is inherently subtree, and apex-only matching would require
  per-host `urlFilter` rules that can't batch and would blow the rule limit.
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
- Adding, removing, enabling/disabling, or editing a list's URL reapplies the list
  slice through `applyListRules()` before the operation returns. URL edits must
  also clear cached raw text and validators (etag/last-modified) for that list.
- Name-only list edits should not clear cached raw text or reapply any slice.
- The global list update alarm is named `update:index` and is anchored to
  `lastListUpdateAttemptAt`. Be careful when changing alarm names because old
  extension installs may have persisted alarms. List CRUD deliberately does not
  re-anchor it; manual and automatic Update All attempts do.
- List fetches reject obvious HTML and enforce response size limits.
- Downloads are validated before they are cached: a body that fails to parse
  rejects like a network failure, so the last known-good cached body (and its
  etag/last-modified/ruleCount) survives and keeps blocking. A list URL that
  starts serving an error page must not silently stop blocking. Only store a
  raw body and its validators together, from the same successful parse.
- `updateAllLists()` returns `{ checked, updated, unchanged, failed }`, counted
  from the outcomes actually merged, and the options page renders that instead of
  claiming every list updated. A rule build that fails outside a UI (the alarm,
  startup reconciliation) records the error, which the lists tab shows. Errors are
  tracked **per slice** (`lastListBuildError`/`lastCustomBuildError`) and only the
  slice that rebuilt clears its own: reconciliation frequently rebuilds one slice
  and not the other, and a successful custom build must not erase the only warning
  that the current list data was never applied.
- Settings exports intentionally omit derived/cache data such as the applied
  counts, `lastListUpdateAttemptAt`, `lastListUpdateCompletedAt`, the two
  build-error keys, raw list bodies, and the navigation guard's
  `guardHostsList`/`guardHostsCustom` sets (rebuilt on import). Imports reset the
  two update timestamps and both build errors (they described the replaced
  config), and must still reject a
  `compiledIndex` field for backward compatibility with v1 exports.
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
- Does a list enable/disable/remove/update/edit path reapply the list slice and
  leave cached raw list text and the UI in a consistent state?
- Do alarms avoid duplicate or stale schedules after upgrades?
- Are parser changes covered by tests for valid, invalid, and skipped input?
- Are extension permission changes reflected in `manifest/chrome.json` and
  justified?
