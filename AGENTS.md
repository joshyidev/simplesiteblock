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
it).

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

Known gap: list CRUD (add/remove/enable/disable/edit) only sets `pendingRebuild`
and does **not** reapply the list slice immediately — changes take effect on the
next Update All. So a removed or disabled list keeps blocking until then.
`pendingRebuild` is recomputed against `appliedSignature` (a fingerprint of the
enabled lists), so a net-zero edit (disable then re-enable) clears it; it stays
set when an enabled list has no cached body yet. Custom rules apply immediately
to their own slice and never affect `pendingRebuild`.

Startup reconciliation: dynamic rules persist in the browser keyed to the
extension ID, so they can outlive the storage that produced them (an unpacked
reload reuses the path-derived ID; a reset wipes storage but leaves the rule
store). `reconcileRules()` clears **orphaned** rules — list rules present when
`appliedSignature` is empty (rebuildListRules never ran in this storage), or
custom rules with no backing text — and restores rules that vanished though some
were last applied (`appliedListRuleCount`/`appliedCustomRuleCount` > 0, with the
`appliedListDomainCount`/`appliedCustomDomainCount` fallback for installs upgraded
from before rule counts were tracked, but the slice is empty). The rule count, not
the block-domain count, is the restore signal so an allow-only slice — which
applies DNR rules but blocks 0 domains — is still restored. It deliberately does
**not** reapply a pending edit: a non-empty
`appliedSignature` that merely diverges from current config is the documented CRUD
gap above, left for the next Update All, not orphan drift. It runs on
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
and the guard would silently never fire (the bug that made both `"close"` mode and
the Brave backstop fail in production). Instead the guard maintains its own host
matcher: each rebuild persists the same normalized block/allow host sets that
produced the DNR rules (`saveGuardHosts` per slice in `lists.js`; storage keys
`guardHostsList`/`guardHostsCustom`), and the guard subtree-matches the navigation
host against them. This means the lists ARE duplicated in storage (DNR is still the
applied source of truth; the host sets are a parallel cache kept in sync on every
rebuild, including reconciliation and import). The matcher is held in memory keyed
by `rulesBuiltAt`, so a non-blocked navigation costs one cheap storage read at most
and the host sets reload only when the rules change. Precedence mirrors the DNR
priority bands: custom allow > custom block > list allow > list block, so `@@`
allow exceptions and custom-over-list overrides resolve identically to DNR.

The `blockAction` setting (`"redirect"` default, or `"close"`) decides what the
guard does on a confirmed block: redirect to the block page (default), or
`tabs.remove` the tab. Only the guard can close a tab — DNR has no close action,
so in `"close"` mode the DNR redirect still fires (a brief block-page load is
possible in Chrome before the tab closes; the blocked content never loads).
Closing is unconditional — closing the blocked URL's only tab will close its
window. `tabs.remove` uses only a tab id, so no extra `tabs` permission is needed.

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
- Settings exports intentionally omit derived/cache data such as `pendingRebuild`,
  raw list bodies, and the navigation guard's `guardHostsList`/`guardHostsCustom`
  sets (rebuilt on import). Imports must still reject a `compiledIndex` field for
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
