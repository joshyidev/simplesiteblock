# Plan: Hide-until-verdict content script

## Status (2026-05-24): SHELVED — future idea, not active

Phase 1 was prototyped (content script + worker message handler + manifest
entries) and verified to remove the cold-start flash, then intentionally
reverted. It is kept here as a documented design for the future. What stayed in
the codebase from that work: the packed-string index encoding in
`src/background/engine.js`, the keep-warm heartbeat, and the read-only
`ssb:verdict` diagnostics message path used by the options page. What was
removed: `src/content/guard.js`, the `content_scripts` manifest entries, and the
`ssb:guard` worker handler.

Re-evaluate this plan if: the flash becomes a priority again, OR Chrome relaxes
its declarativeNetRequest rule limits (the 30k cap is the main reason DNR can't
cover ~800k rules today; if that changes, DNR may become the simpler zero-flash
path and could make this content-script approach unnecessary).

## Goal

Eliminate the block-page flash for an NSFW use case at ~800k rules, where
declarativeNetRequest cannot hold the full list (Chrome caps dynamic + session
rules at 30,000, and static rules guarantee only ~30,000).

The strategy moves enforcement out of the observational `webNavigation`
reaction and into the page itself: a content script injected at
`document_start` hides page content _before paint_, asks the background worker
for a verdict, and only reveals the page on an explicit allow. Matching stays in
the existing JS engine (which holds 800k hosts comfortably), so there is no
rule-count limit. The worst-case failure becomes a brief blank page, never an
NSFW flash.

This plan is Chrome-first but written to also build for Firefox.

## Non-goals

- Replacing the host matcher. `src/background/engine.js` is reused as-is.
- Putting the full list in DNR. DNR is out of scope here (tracked separately as
  an optional top-N accelerator).
- Changing rule semantics (exact vs subtree) or the lists/options UX.

## Current architecture (reference)

- `src/background/service_worker.js` blocks on
  `webNavigation.onBeforeNavigate` (frame 0 only). This is observational: the
  page begins loading and the worker reacts via `tabs.update` (redirect to
  `src/blocked/blocked.html`) or `tabs.remove` (close tab). This is the source
  of the flash.
- `src/background/engine.js` `evaluate(url, index)` returns
  `{ blocked, reason }`. Reused unchanged.
- `src/background/storage.js` `getHydratedState()` provides
  `{ settings, index, ... }`. The worker caches it in `stateReady` and is kept
  warm by the `keepWorkerWarm` heartbeat in `service_worker.js`.
- Host permissions in both manifests already cover `http://*/*` and
  `https://*/*`, so no new permission prompt is required for an all-pages
  content script.

## Design overview

1. New content script `src/content/guard.js`, `run_at: document_start`, runs in
   the main frame (Phase 1) and later all frames (Phase 2).
2. On execution it synchronously injects a hide style into
   `document.documentElement` so nothing paints.
3. It sends the current URL to the worker and awaits a verdict.
4. Worker resolves the verdict from the warm `evaluate()` path:
   - allow -> reply allow; content script removes the hide style (reveal).
   - block -> worker performs the block action against `sender.tab.id`
     (redirect to blocked page, or close tab); the hidden page is navigated
     away before it is ever shown.
5. `webNavigation.onBeforeNavigate` is kept as a backstop, not the primary path.

Hiding is synchronous and happens before paint; only the reveal/redirect is
async. That is what prevents NSFW pixels from reaching the screen.

## Hide / reveal mechanism

At `document_start`, `document.documentElement` exists but `body` and
subresources do not yet. Inject a style element that hides the root:

```js
const HIDE_ID = "ssb-guard-hide";
const style = document.createElement("style");
style.id = HIDE_ID;
// visibility (not display:none) preserves layout and avoids breaking scripts
// that measure the page, while still hiding all rendered content incl. images.
style.textContent = ":root{visibility:hidden !important}";
document.documentElement.appendChild(style);
```

Reveal removes the element:

```js
document.getElementById(HIDE_ID)?.remove();
```

Notes:

- Use `visibility:hidden` over `display:none` to reduce layout/script breakage on
  allowed pages.
- Re-assert the style if it is removed by the page before the verdict returns
  (rare; can guard with a short-lived MutationObserver if testing shows it).

## Messaging protocol

Content script -> worker (`ext.runtime.sendMessage`):

```
{ type: "ssb:verdict", url: location.href }
```

Worker -> content script (response):

```
{ blocked: boolean, reason?: string }
```

Worker handler (new, in `service_worker.js`):

```js
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ssb:verdict") return false;
  void respondWithVerdict(message.url, sender, sendResponse);
  return true; // keep the channel open for the async response
});

async function respondWithVerdict(url, sender, sendResponse) {
  const state = await loadState();
  const verdict = evaluate(url, state.index);
  if (verdict.blocked && sender.tab?.id != null) {
    await applyBlockAction(sender.tab.id, url, verdict, state.settings);
  }
  sendResponse({ blocked: verdict.blocked, reason: verdict.reason });
}
```

## Worker refactor

Extract the existing action logic from `handleNavigation` into a shared
`applyBlockAction(tabId, url, verdict, settings)` so both the message path and
the `onBeforeNavigate` backstop reuse it:

- `settings.blockAction === "close_tab"` (or incognito tab) -> `tabs.remove`.
- otherwise -> `tabs.update` to
  `src/blocked/blocked.html?url=...&reason=...`.

Using the worker for the block action avoids needing `web_accessible_resources`
(the content script never navigates to the extension page itself).

## Failure handling (decision required)

Because every navigation is hidden until a verdict, worker latency and failures
are now user-visible on _all_ sites, not just blocked ones.

- Keep the `keepWorkerWarm` heartbeat. A warm worker answers in single-digit ms,
  so the blank is imperceptible. The keep-alive memory tradeoff is justified by
  this design (see the memory note about worker keep-alive).
- Add a reveal timeout in the content script (e.g. 1000 ms). If no verdict
  arrives, reveal the page. This is **fail-open**: it prevents a dead worker
  from blanking the whole web, at the cost of a possible flash if the worker is
  down. For NSFW we should make the timeout generous enough that warm responses
  always win, and treat a down worker as the rare exception.
- Decision to confirm: fail-open (reveal on timeout, web stays usable) vs
  fail-closed (stay hidden / redirect to blocked page on timeout, safer but a
  worker outage breaks browsing). Recommend fail-open with a generous timeout +
  warm worker, revisited if testing shows flashes.

## bfcache / back-forward

Back navigation can restore a page from bfcache without a fresh load, so the
content script may not re-run. Handle `pageshow`:

```js
window.addEventListener("pageshow", (e) => {
  if (e.persisted) requestVerdict(); // re-hide + re-verify
});
```

## Manifest changes

Add to both `manifest/chrome.json` and `manifest/firefox.json` (host
permissions already present):

```json
"content_scripts": [
  {
    "matches": ["http://*/*", "https://*/*"],
    "js": ["src/content/guard.js"],
    "run_at": "document_start",
    "all_frames": false
  }
]
```

- Phase 2 flips `all_frames` to `true` for embedded NSFW (iframes/images on
  otherwise-allowed pages), which the current top-level-only engine misses.
- Confirm `scripts/build.js` copies `src/content/` into `dist/`.
- The content script is a classic content script (not a module); keep it
  dependency-free and browser-native, consistent with project style.

## Phasing

- Phase 1: main-frame hide-until-verdict + worker message handler +
  `applyBlockAction` refactor + reveal timeout + bfcache handling. Keep
  `onBeforeNavigate` backstop and keep-warm.
- Phase 2: `all_frames: true` to cover embedded content; verify per-frame hide
  and that allow on a subframe reveals only that frame.
- Phase 3 (optional, separate): DNR top-N accelerator for the highest-traffic
  domains so the most common hits are blocked with zero render. Stays under the
  30k cap; does not attempt the full 800k.

## Testing

- Unit (node --test): factor verdict resolution so it is testable without the
  DOM. Add `test/messaging.test.js` covering `respondWithVerdict` with a mocked
  `sender`/`sendResponse` and a stub index: allow URL -> reply allow, no action;
  block URL -> reply block + `applyBlockAction` invoked with the tab id.
- Reuse existing `engine.js` coverage for matching; do not duplicate.
- Manual (load unpacked, Chrome):
  - Navigate to a blocked host: no NSFW paint; lands on blocked page (or tab
    closes in close_tab mode).
  - Navigate to an allowed host: brief/no blank, page reveals normally.
  - Cold worker (wait >30s idle, or reload extension): worst case is a blank,
    never NSFW.
  - Back button into a previously blocked page (bfcache): re-blocked.
  - Worker forced offline: confirm the fail-open timeout reveals allowed pages.
- Note in the handoff if browser verification was not feasible and what was
  covered by automated tests.

## Risks and open questions

- document_start runs before paint in the common case, but timing is not
  contractually guaranteed across all load paths; validate against real sites,
  especially fast cache hits and prerendered pages.
- Blank-on-every-navigation is a site-wide UX cost; verdict latency (warm
  worker) is the mitigation. Measure it.
- Fail-open vs fail-closed timeout: confirm the policy above.
- All-pages content script means the extension runs on every site. Permission
  is already granted, but document the privacy posture honestly in user-facing
  copy.
- SPA in-page route changes within the same host do not change a host-only
  verdict, so no re-check is needed; cross-host SPA transitions are rare and can
  be deferred.
- Performance: keep `guard.js` tiny and allocation-free on the hot path; the
  index never ships to the page (stays in the worker), so per-tab memory is
  negligible.

## Files touched

- New: `src/content/guard.js`
- Edit: `src/background/service_worker.js` (onMessage handler, `applyBlockAction`
  refactor; keep `onBeforeNavigate` + keep-warm)
- Edit: `manifest/chrome.json`, `manifest/firefox.json` (content_scripts)
- Possibly: `scripts/build.js` (ensure `src/content/` is bundled)
- New: `test/messaging.test.js`
