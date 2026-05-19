# SimpleSiteBlock

SimpleSiteBlock is a Manifest V3 Chrome extension for blocking top-level navigations using hosts-file lists, a supported subset of Adblock syntax, and user-entered custom Adblock rules.

The code is plain ES modules with no bundler. The extension has four main surfaces:

- A background service worker that evaluates navigations and schedules list updates.
- An options page for settings, list management, custom rules, password lock, and diagnostics.
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
    lastUnlockAt: number
  },
  lists: [/* list metadata */],
  rawLists: { [listId]: "raw list text" },
  customRules: "raw custom Adblock rules",
  compiledIndex: {
    hostBlocks: string[],
    hostAllows: string[],
    regexBlocks: { source, flags }[],
    regexAllows: { source, flags }[],
    builtAt: number
  }
}
```

`getState()` returns defaults for missing keys. `getHydratedState()` additionally turns `compiledIndex` into runtime objects: `Set` for host rules and `RegExp` instances for regex rules.

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
2. Check host allow rules.
3. Check regex allow rules.
4. Check host block rules.
5. Check regex block rules.

Host matching walks up subdomains. For `a.b.example.com`, it checks:

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

It skips local aliases such as `localhost`.

### Adblock Parser

[src/background/parser/adblock.js](src/background/parser/adblock.js)

Supported rule types include:

- `||example.com^` host blocks.
- `@@||example.com^` host allow rules.
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

- `addList({ name, url, updateIntervalDays })`
  - Creates metadata.
  - Fetches the URL immediately.
  - Rolls back the list if fetch or validation fails.
- `updateListNow(listId)`
  - Fetches a list.
  - Sends conditional headers when `etag` or `lastModified` are available.
  - Rejects HTML responses and oversized responses.
  - Parses and validates the body.
  - Stores raw text and metadata.
  - Recompiles the combined index.
- `updateListSettings(listId, patch)`
  - Changes enabled/update settings.
  - Recompiles and reconciles alarms.
- `removeList(listId)`
  - Deletes metadata and raw text.
  - Recompiles and reconciles alarms.
- `updateCustomRules(rawRules)`
  - Validates custom Adblock rules.
  - Stores them.
  - Recompiles the combined index.
- `compileAndStoreIndex()`
  - Parses enabled lists and custom rules.
  - Merges them into one compiled index.
  - Stores it in `chrome.storage.local`.
- `reconcileAlarms()`
  - Clears existing `update:<listId>` alarms.
  - Recreates alarms for enabled lists with an update interval.

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

The options page renders four full-width/half-width areas:

- Block action.
- Password.
- Lists.
- Custom rules.
- Diagnostics.

The page reads state with `getState()` and re-renders after mutations.

List controls:

- Add list by name and URL.
- Toggle enabled state.
- Change update interval.
- Update now.
- Remove.

Custom rules:

- A textarea accepts Adblock syntax.
- Saving validates and recompiles immediately.

Diagnostics:

- Shows total compiled rules, build time, and storage usage.
- A test URL input runs `evaluate()` against the compiled index.
- Bare domains are normalized to `https://...` before testing.

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

[test/parser-engine.test.js](test/parser-engine.test.js) uses Node's built-in test runner.

It covers:

- Hosts parsing.
- Adblock parsing.
- Allow-before-block behavior.
- Compiled index serialize/hydrate behavior.
- Auto detection for hosts vs. Adblock.
- Rejection of ordinary web pages and non-list text.
- Custom rules parsing and validation.

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
- Change the options UI: `options.js` and `options.css`.
- Change blocked-page content: `src/blocked/*`.
- Change popup content: `src/popup/*`.
