# SimpleSiteBlock

SimpleSiteBlock is a Manifest V3 Chrome extension for blocking top-level navigations using hosts-file lists, a supported subset of Adblock syntax, and user-entered custom rules.

The code is plain ES modules with no bundler. The extension has four main surfaces:

- A background service worker that evaluates navigations and schedules list updates.
- An options page for settings, list management, custom rules, import/export, password lock, and diagnostics.
- A blocked page shown when the global action is set to show a block page.
- A small action popup shown when the extension icon is clicked.

## Manifest

[manifest.json](manifest.json) declares the extension entry points and permissions.

Important entries:

- `background.service_worker`: [src/background/service_worker.js](src/background/service_worker.js)
- `options_page`: [src/options/options.html](src/options/options.html)
- `action.default_popup`: [src/popup/popup.html](src/popup/popup.html)
- permissions:
  - `webNavigation`: observe top-level navigations.
  - `tabs`: close tabs or redirect them to the blocked page.
  - `storage`: persist settings, lists, custom rules, raw list text, and compiled index.
  - `unlimitedStorage`: avoid quota problems with larger lists.
  - `alarms`: schedule list updates.
- host permissions:
  - `http://*/*`
  - `https://*/*`

Blocking is implemented through `webNavigation` plus the JavaScript matcher.

## Storage Model

[src/background/storage.js](src/background/storage.js) wraps `chrome.storage.local`.

The persisted state is:

```js
{
  settings: {
    blockAction: "show_block_page" | "close_tab",
    passwordEnabled: boolean,
    passwordHash: null | { algo, salt, iterations, hash },
    lastUnlockAt: number,
    updateIntervalDays: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  },
  lists: [{
    id: string,
    name: string,
    url: string,
    format: "auto" | "hosts" | "adblock",
    enabled: boolean,
    lastError: null | string,
    etag: null | string,
    lastModified: null | string,
    ruleCount: number
  }],
  rawLists: { [listId]: "raw list text" },
  customRules: "raw custom Adblock rules",
  compiledIndex: {
    hostBlocksExact: string[],
    hostAllowsExact: string[],
    hostBlocksSubtree: string[],
    hostAllowsSubtree: string[],
    regexBlocks: { source, flags }[],
    regexAllows: { source, flags }[],
    builtAt: number
  },
  pendingRebuild: boolean
}
```

`getState()` returns defaults for missing keys. `getHydratedState()` additionally turns `compiledIndex` into runtime objects: `Set` for host rules and `RegExp` instances for regex rules.

`compiledIndex` is the blocking source of truth. `pendingRebuild` means list metadata or raw-list availability changed and the compiled index may not reflect those changes until an update/rebuild path runs.

## Blocking Flow

The background service worker is [src/background/service_worker.js](src/background/service_worker.js).

1. `chrome.webNavigation.onBeforeNavigate` fires.
2. The listener ignores subframes and non-tab navigations.
3. `handleNavigation()` loads the hydrated state.
4. [src/background/engine.js](src/background/engine.js) evaluates the URL.
5. If the URL is allowed, nothing happens.
6. If the URL is blocked:
   - In incognito windows, the tab is always closed.
   - If `settings.blockAction` is `close_tab`, the tab is closed.
   - Otherwise, the tab is redirected to [src/blocked/blocked.html](src/blocked/blocked.html) with the blocked URL and reason in the query string.

This is a navigation replacement model. It observes navigation and reacts; it is not a pre-request network-canceling layer in the current checked-in code.

## Engine

[src/background/engine.js](src/background/engine.js) is the pure matching core.

Key exports:

- `hydrateIndex(serialized)`: converts stored arrays into runtime `Set` and `RegExp` objects.
- `serializeIndex(index)`: converts runtime objects back into JSON-serializable storage shape.
- `createCombinedIndex(parsedLists)`: merges parsed list outputs into one compiled index.
- `evaluate(url, index)`: returns `{ blocked: false }` or `{ blocked: true, reason }`.

Matching order:

1. Ignore invalid URLs and non-HTTP(S) URLs.
2. Check exact host allow rules.
3. Check subtree host allow rules.
4. Check regex allow rules.
5. Check exact host block rules.
6. Check subtree host block rules.
7. Check regex block rules.

Exact host rules match only the visited hostname. A hosts-file mapping or bare domain rule for `example.com` blocks `example.com`, but not `www.example.com`.

Subtree host rules come from Adblock host rules such as `||example.com^`. Subtree matching walks up subdomains. For `a.b.example.com`, it checks:

- `a.b.example.com`
- `b.example.com`
- `example.com`

## Parsers

The parser modules are pure and covered by Node tests.

### Hosts Parser

[src/background/parser/hosts.js](src/background/parser/hosts.js)

This parser accepts hosts-file mapping lines where the first token is one of:

- `0.0.0.0`
- `127.0.0.1`
- `::`
- `::1`

It strips `#` comments, normalizes domains to lowercase ASCII/punycode, trims one trailing dot, and rejects invalid DNS labels.

Hosts-file entries are exact host blocks. It skips local aliases such as `localhost`.

### Adblock Parser

[src/background/parser/adblock.js](src/background/parser/adblock.js)

Supported rule types include:

- `||example.com^` host blocks.
- `@@||example.com^` host allow rules.
- `example.com` exact host blocks.
- `|https://example.com/path*` URL pattern rules.
- `example.com/ads` generic URL pattern rules.
- `/regex/` regex rules.

Unsupported or intentionally skipped syntax:

- Cosmetic rules such as `##`, `#@#`, and `#?#`.
- Scriptlet/snippet-like rules.
- Some advanced options such as `$csp=`.
- Whitespace-heavy prose lines, which helps avoid treating normal web pages as block lists.

The parser returns host block/allow sets and regex block/allow records.

## Lists And Updates

[src/background/lists.js](src/background/lists.js) owns list lifecycle and compilation.

Important functions:

- `addList({ name, url })`
  - Normalizes and deduplicates the URL.
  - Creates metadata with `format: "auto"` and `enabled: true`.
  - Does not fetch immediately.
  - Marks `pendingRebuild` so the UI can prompt for `Update All`.
- `updateAllLists()`
  - Fetches all enabled lists.
  - Stores per-list fetch errors in `lastError`.
  - Stores fresh raw text, validators, and metadata for successful fetches.
  - Recompiles the combined index after fetches settle.
- `updateListNow(listId)`
  - Fetches a list.
  - Sends conditional headers only when `etag`/`lastModified` and a cached raw body are available.
  - Rejects HTML responses and oversized responses.
  - Parses and validates the body.
  - Stores raw text and metadata.
  - Recompiles the combined index by default, or marks `pendingRebuild` when called with `compile: false`.
- `updateListSettings(listId, patch)`
  - Changes list settings.
  - Marks `pendingRebuild` when `enabled` or `format` changes.
- `removeList(listId)`
  - Deletes metadata and raw text.
  - Marks `pendingRebuild`.
- `updateCustomRules(rawRules)`
  - Validates custom Adblock rules.
  - Stores them.
  - Recompiles the combined index.
- `compileAndStoreIndex()`
  - Parses enabled lists and custom rules.
  - Merges them into one compiled index.
  - Stores it in `chrome.storage.local`.
- `reconcileAlarms()`
  - Reconciles the single global `update:index` alarm.
  - Uses `settings.updateIntervalDays`; `0` disables scheduled updates.

List fetches keep `etag` and `lastModified` validators. Conditional headers are intentionally skipped when the raw cached body is missing, because a `304 Not Modified` response is only useful when the extension has a body to reuse.

Auto format detection:

- If hosts mappings are present, the list is treated as hosts format.
- Otherwise, the list is parsed as Adblock syntax.
- HTML-looking content and empty/non-list text are rejected.

## Options Page

The options UI is:

- [src/options/options.html](src/options/options.html)
- [src/options/options.css](src/options/options.css)
- [src/options/options.js](src/options/options.js)
- [src/options/lock.js](src/options/lock.js)

The options page renders these areas:

- Lists.
- Custom rules.
- Block action.
- Import / Export.
- Password.
- Diagnostics.

The page reads state with `getState()` and re-renders after mutations.

List controls:

- Add list by name and URL.
- Toggle enabled state.
- Change update interval.
- Update all enabled lists.
- Remove.
- See a pending-rebuild notice when list changes have not yet been compiled into the index.

Custom rules:

- A textarea accepts Adblock syntax.
- Saving validates and recompiles immediately.

Diagnostics:

- Shows total compiled rules and build time in the Lists header.
- A test URL input runs `evaluate()` against the compiled index.
- Bare domains are normalized to `https://...` before testing.

Import / Export:

- Exports block action, auto-update interval, list metadata, and custom rules.
- Omits derived data such as `compiledIndex` and raw list bodies.
- Includes password settings only when the user checks the export option.
- Imports validate settings, lists, custom rules, and any included raw list bodies before replacing current storage.
- Imports without raw bodies mark `pendingRebuild` when enabled lists need to be downloaded.

## Password Lock

Password hashing lives in [src/background/crypto.js](src/background/crypto.js).

It uses:

- PBKDF2-SHA-256.
- Random 16-byte salt.
- 250k iterations.
- 32-byte output.

[src/options/lock.js](src/options/lock.js) handles the options-page lock view.

The lock is a soft UI gate:

- It protects the options UI from casual access.
- It does not prevent someone with Chrome profile access from clearing extension storage or disabling/uninstalling the extension.
- Unlock state lives in `sessionStorage`, so it is scoped to that options page tab.

Once the options page is unlocked:

- Changing the password requires entering and confirming the new password.
- Disabling the password does not ask for the current password again.

## Blocked Page

The blocked page is:

- [src/blocked/blocked.html](src/blocked/blocked.html)
- [src/blocked/blocked.css](src/blocked/blocked.css)
- [src/blocked/blocked.js](src/blocked/blocked.js)

It reads `url` and `reason` from `location.search` and displays them.

There is intentionally no unblock button or options button on this page.

## Extension Popup

The browser-action popup is:

- [src/popup/popup.html](src/popup/popup.html)
- [src/popup/popup.css](src/popup/popup.css)
- [src/popup/popup.js](src/popup/popup.js)

It reads the extension name and version from `chrome.runtime.getManifest()` and provides an `Open options` button.

## Tests

Tests use Node's built-in test runner.

Current test files:

- [test/parser-engine.test.js](test/parser-engine.test.js)
- [test/backup.test.js](test/backup.test.js)
- [test/crypto.test.js](test/crypto.test.js)

They cover:

- Hosts parsing.
- Adblock parsing.
- Allow-before-block behavior.
- Compiled index serialize/hydrate behavior.
- Auto detection for hosts vs. Adblock.
- Rejection of ordinary web pages and non-list text.
- Custom rules parsing and validation.
- List lifecycle behavior, pending rebuilds, alarm reconciliation, and conditional fetch edge cases.
- Settings import/export validation.
- Password hashing and verification.

Run tests with:

```sh
npm test
```

## Common Change Points

Use these files as starting points:

- Add a new setting: `storage.js`, then `options.js`, then any background logic using it.
- Change matching behavior: `engine.js` and tests.
- Support more hosts syntax: `parser/hosts.js` and tests.
- Support more Adblock syntax: `parser/adblock.js` and tests.
- Change list update behavior: `lists.js`.
- Change import/export behavior: `backup.js` and tests.
- Change the options UI: `options.js` and `options.css`.
- Change blocked-page content: `src/blocked/*`.
- Change popup content: `src/popup/*`.
