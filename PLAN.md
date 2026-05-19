# SimpleSiteBlock — Implementation Plan

A Chrome extension (Manifest V3) that blocks sites using hosts-file or Adblock-syntax block lists.

## 1. Scope & confirmed decisions

- **Blocking mechanism:** `chrome.webNavigation.onBeforeNavigate` on top-level navigations. The service worker decides per-navigation whether to redirect to a block page or close the tab. This is a navigation-replacement approach, not a true network-canceling API.
- **Block action:** single global setting — `show_block_page` (default) or `close_tab`.
- **Password gate:** opt-in. When enabled, the options page is locked behind a password; the blocking engine continues to work regardless of lock state. Documented as a soft lock (storage is accessible to anyone with disk access; Chrome does not let extensions prevent their own disable/uninstall outside enterprise policy).
- **List updates:** user-configurable per list, interval `1`–`7` days, scheduled via `chrome.alarms`.
- **Supported list formats:** hosts file and a useful subset of Adblock Plus filter syntax (see §4).

## 2. Manifest & permissions

Manifest V3, background service worker. Required permissions:

| Permission | Why |
| --- | --- |
| `webNavigation` | Observe top-level navigations to evaluate blocks |
| `tabs` | Close tabs and redirect when blocking |
| `storage` | Persist lists, rules, settings, password hash |
| `unlimitedStorage` | Avoid `chrome.storage.local` quota failures when users subscribe to large/multiple lists |
| `alarms` | Schedule periodic list updates (up to every 7 days) |
| `host_permissions: ["http://*/*", "https://*/*"]` | Fetch arbitrary HTTP(S) list URLs from the extension service worker/options page |

No `declarativeNetRequest` in v1 — the engine is fully in JS so we can implement “close tab” and a unified hosts+adblock matcher. If strict pre-request cancellation becomes a requirement later, revisit DNR dynamic rules as a second blocking layer.

## 3. File layout

```
manifest.json
src/
  background/
    service_worker.js        # entry; wires alarms + webNavigation listener
    engine.js                # evaluate(url) -> { blocked, reason } using hydrated index
    lists.js                 # add/remove/update lists, fetch, schedule alarms
    parser/
      hosts.js               # hosts-file parser -> hostname set
      adblock.js             # adblock parser -> compiled rule records
    storage.js               # typed wrappers around chrome.storage.local
    crypto.js                # PBKDF2 hash/verify for password
  options/
    options.html             # settings UI (lists, action, password, update interval)
    options.js
    options.css
    lock.js                  # password gate logic rendered inside options.html
  blocked/
    blocked.html             # block page shown on redirect
    blocked.js               # reads ?url=&reason= query params, renders details
icons/ (16, 32, 48, 128)
```

## 4. List parsing

### 4.1 Hosts file

Per line:
- Strip `#` comments.
- Tokenize on whitespace. Skip blank lines.
- If first token is an IP (`0.0.0.0`, `127.0.0.1`, `::`, `::1`) and there are 2+ tokens, treat the remaining tokens as hostnames to block.
- Skip entries for `localhost`, `localhost.localdomain`, `broadcasthost`, `local`.
- Lowercase and normalize hostnames: trim one trailing dot, convert Unicode domains to ASCII/punycode with `URL`, and drop entries that are not valid DNS labels.

Output: `Set<string>` of blocked hostnames.

### 4.2 Adblock syntax (supported subset)

We deliberately support only network-blocking rules. Cosmetic rules (`##`, `#@#`, `#?#`) are parsed and ignored with a warning.

Supported:

| Syntax | Handling |
| --- | --- |
| `\|\|example.com^` | Block hostname `example.com` and all subdomains → goes into hostname set |
| `\|\|example.com^$third-party` etc. | Hostname rule; options are parsed but ignored for v1. Documented limitation. |
| `@@\|\|example.com^` | Allowlist hostname → exception set, checked first |
| `\|http://example.com/path*` | Compiled to regex |
| `example.com/ads` | Compiled to regex (substring-anchored) |
| `/regex/` | Used as-is after validation |
| `!` line, blank line | Comment / skip |

Unsupported (logged, skipped): `##` cosmetic, `#@#`, `#?#`, `$csp=…`, snippet rules, scriptlet injections.

Parser output and persisted regex representation:
```
{
  hostBlocks: Set<string>,
  hostAllows: Set<string>,
  regexBlocks: { source: string, flags: string }[],
  regexAllows: { source: string, flags: string }[]
}
```

Regex rules are validated at parse time and capped to a reasonable length so a bad subscription cannot break every navigation evaluation.

### 4.3 Compilation

On every list change/update, the background recompiles a single combined index stored in memory (and mirrored to `chrome.storage.local` so a service-worker wake doesn’t re-parse from raw text). The persisted shape must be JSON-serializable:

```
{
  hostBlocks: string[],      // hydrated to Set<string>
  hostAllows: string[],      // hydrated to Set<string>
  regexBlocks: { source: string, flags: string }[],
  regexAllows: { source: string, flags: string }[],
  builtAt: number
}
```

Subdomain match: for `host = a.b.example.com`, check `a.b.example.com`, `b.example.com`, `example.com` against the set (split on `.`, walk up).

The hydrated runtime index wraps host arrays as `Set<string>` and regex records as `RegExp` instances before passing the index to `evaluate()`.

## 5. Blocking engine

```js
// engine.js
function evaluate(url, index) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { blocked: false };
  const host = u.hostname.toLowerCase();

  if (matchesHost(index.hostAllows, host)) return { blocked: false };
  for (const r of index.regexAllows) if (r.test(url)) return { blocked: false };

  if (matchesHost(index.hostBlocks, host)) return { blocked: true, reason: `host:${host}` };
  for (const r of index.regexBlocks) if (r.test(url)) return { blocked: true, reason: `regex:${r.source}` };

  return { blocked: false };
}
```

Service-worker listener:

```js
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;            // top-level only
  void handleNavigation(details);
});

async function handleNavigation(details) {
  const state = await getHydratedState();
  const verdict = evaluate(details.url, state.index);
  if (!verdict.blocked) return;

  if (state.settings.blockAction === 'close_tab') {
    chrome.tabs.remove(details.tabId).catch(() => {});
  } else {
    const target = chrome.runtime.getURL(
      `src/blocked/blocked.html?url=${encodeURIComponent(details.url)}&reason=${encodeURIComponent(verdict.reason)}`
    );
    chrome.tabs.update(details.tabId, { url: target });
  }
}
```

Notes:
- `webNavigation` reports navigation state; it is not a blocking API and has no guaranteed ordering with lower-level network events. In normal use the redirect/close should happen before the destination page commits, but the plan should not claim the original request is canceled.
- Register listeners synchronously at module top level. The handler may await `getHydratedState()`, but listener registration itself must not be delayed by storage reads.
- The engine state must be hydrated from `chrome.storage.local` on service-worker startup (the worker is ephemeral in MV3). Keep a single `stateReady` promise so cold-start navigations share the same initialization.
- Listen to `chrome.storage.onChanged` or route all option mutations through messages so the service worker updates its in-memory index after settings/list changes.

## 6. Settings & storage schema

`chrome.storage.local`:

```jsonc
{
  "settings": {
    "blockAction": "show_block_page" | "close_tab",
    "passwordEnabled": false,
    "passwordHash": null,           // { algo, salt, iterations, hash } when enabled
    "lastUnlockAt": 0
  },
  "lists": [
    {
      "id": "uuid",
      "name": "StevenBlack hosts",
      "url": "https://...",
      "format": "hosts" | "adblock" | "auto",
      "enabled": true,
      "updateIntervalDays": 7,      // 1..7, 0 = manual only
      "lastUpdatedAt": 0,
      "lastError": null,
      "etag": null,
      "lastModified": null,
      "ruleCount": 0
    }
  ],
  "rawLists": { "<listId>": "<raw text>" },     // last fetched bodies
  "compiledIndex": { ... }                       // JSON-serializable shape from §4.3
}
```

Sync vs local: use `local` only. Lists can exceed `storage.sync` quotas; settings live with them for simplicity.

Storage size policy: request `unlimitedStorage`, show bytes used via `chrome.storage.local.getBytesInUse()` in diagnostics, and reject any single fetched list above a documented max size (for example 10 MB compressed response / 25 MB text) with a clear `lastError`.

## 7. List update scheduler

- On install / settings change, reconcile alarms: for each enabled list with `updateIntervalDays > 0`, ensure an alarm named `update:<listId>` exists with `periodInMinutes = days * 1440`.
- `chrome.alarms.onAlarm` → fetch that list, parse, recompile index, update `lastUpdatedAt` / `lastError`.
- Manual “Update now” button per list in options.
- Fetch sends `If-None-Match` when an `etag` is stored; on 304 just bump `lastUpdatedAt`.
- Store `lastModified` too and send `If-Modified-Since` when available; not every list host emits `ETag`.
- Recompile is debounced (e.g., 500 ms) when multiple lists update back-to-back.
- Fetch timeouts and non-2xx responses should not replace the last known good raw list.

## 8. Password protection

- **Hashing:** `crypto.subtle` PBKDF2-SHA-256, random 16-byte salt, 250k iterations, 32-byte output. Stored as `{algo, salt, iterations, hash}` (base64).
- **Enable flow:** options page asks for new password + confirm → store hash, set `passwordEnabled = true`.
- **Disable / change:** require current password first.
- **Lock UX:** when the options page loads and `passwordEnabled` is true, render the locked view from `lock.js` inside `options.html`; the rest of the UI is only mounted after a successful verify. The service worker is *not* involved in unlock — it’s purely a UI gate, and the options page reads/writes storage directly only after unlock.
- **Session:** unlock state lives in `sessionStorage` of the options page (cleared when the tab closes). No global unlock across tabs.
- **Reset path:** documented — user can clear extension storage via `chrome.storage.local.clear()` from devtools, or uninstall/reinstall. We will not implement a recovery code in v1.
- **Threat model (documented in README):** the lock prevents casual tampering by a roommate / coworker / younger sibling. It is not a security boundary; anyone with the Chrome profile on disk can read/clear `chrome.storage.local`.

## 9. Options page UI

Sections:
1. **Block action** — radio: Show block page / Close tab.
2. **Lists** — table of subscribed lists: name, URL, format, enabled toggle, update interval (`Manual`, `1`..`7` days), last updated, rule count, “Update now”, “Remove”. “Add list” form (name, URL, format=auto).
3. **Password** — enable toggle; when enabled show change/disable controls.
4. **Diagnostics** — total rules, last build time, storage bytes used, “Test URL” box that runs `evaluate()` and shows the verdict.

## 10. Block page

`blocked.html` reads `?url=` and `?reason=` from `location.search`, shows:
- The blocked URL.
- Which rule matched.
- A neutral message (“This site is blocked by SimpleSiteBlock”).
- A link to the options page.

No “unblock” button — bypass requires editing the list in settings (and unlocking if password is on).

## 11. Build, test, ship

- **Build:** no bundler initially. Plain ES modules loaded by `service_worker.js` (`"type": "module"` in manifest) and the options/blocked pages. Revisit if we add dependencies.
- **Tests:** Node-based unit tests for `parser/hosts.js`, `parser/adblock.js`, `engine.js`, and compiled-index serialize/hydrate helpers (pure functions, no chrome.* needed). Fixtures: small hosts file, small EasyList excerpt, IDN/trailing-dot hosts, allowlist precedence, invalid regex, expected match/no-match URLs.
- **Manual QA checklist:** install unpacked, add a known list (e.g., StevenBlack), confirm a blocked host redirects to block page, switch to close-tab mode, confirm tab closes, enable password, reopen options, confirm gate, trigger alarm manually via `chrome.alarms` devtools.
- **Packaging:** `zip -r simplesiteblock.zip manifest.json src icons` for Chrome Web Store upload (out of scope for v1 development).

## 12. Known limitations (to surface in README)

- Because v1 uses `webNavigation` plus `tabs.update()`/`tabs.remove()`, Chrome may begin lower-level network work before the extension redirects or closes the tab. The user-facing page should not commit, but this is not equivalent to DNR/webRequest-style request cancellation.
- Sub-resource blocking (ads inside a page) is **not** implemented — we only act on top-level navigations, per the requirement “when a site in the address bar matches.”
- Adblock filter options (`$third-party`, `$domain=`, etc.) are parsed but ignored.
- Password lock is a UI gate, not encryption.
- Extension cannot prevent its own disable/uninstall in consumer Chrome.

## 13. Milestones

1. Skeleton: manifest, service worker, options page shell, block page, storage wrapper.
2. Hosts parser + engine + `onBeforeNavigate` integration → block by static list works.
3. Lists CRUD in options + fetch + alarms-based updates.
4. Adblock parser (hostname rules first, then regex rules).
5. Password gate.
6. Diagnostics / test-URL tool, polish, README with limitations.
