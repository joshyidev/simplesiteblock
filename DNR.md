# Rewrite SimpleSiteBlock to use DNR

## Goals and non-goals

**Goals**

- Let the user subscribe to any number of filter lists in hosts or adblock syntax
- Fetch lists on a schedule and apply them as dynamic DNR rules
- Show a custom block page on top-level navigation
- Provide an "add this domain" personal blocklist on top of subscribed lists
- Surface errors clearly when a list fails to parse or exceeds quota

**Non-goals**

- Cosmetic filtering (still domain-only)
- Supporting the full adblock syntax — only the subset that maps cleanly to DNR
- Exact-host (no-subdomain) matching — every rule matches a host and all its
  subdomains (see "Matching model" below)
- A "close tab" block action — v2 always shows the block page (see "Block page")
- Unbypassable blocking
- Sync across devices (v1 is local-only)

## Matching model

Every block and allow rule matches a host **and all of its subdomains**. There
is no exact-host (apex-only) matching. This is a deliberate departure from the
v1 engine, which distinguished exact host rules from subtree rules.

Two constraints force this:

1. **Budget.** The only DNR condition that batches many domains into one rule is
   `requestDomains` (≈1,000 domains/rule), and it matches the listed domain plus
   all subdomains. The only way to get apex-only matching is a left-anchored
   `urlFilter` pattern, which is one pattern per rule — a 142k-entry hosts file
   would become 142k rules and blow the 30,000 dynamic-rule limit instantly.
2. **Ecosystem norm.** Subtree matching is what every mainstream blocker does
   (uBO's canonical `||domain^` is subtree). v1's exact-default was the outlier.

The accepted consequence: a v1-style exact entry such as `0.0.0.0 example.com`
now also blocks `www.example.com` and any other subdomain. For a blocklist this
is almost always what the user wants. The only loser is a list that intends to
block an apex while leaving subdomains reachable — vanishingly rare, and
arguably a bug in the list.

Hosts are keyed **as written** (validated, lowercased, IDN→ASCII), not reduced
to their registrable domain. See "Normalization" for why eTLD+1 reduction is
dropped.

## Constraints driving the design

DNR dynamic rules cap at 30,000 total, with up to 30,000 "safe" rules (which is what block rules count as). With ~1,000 domains packed per rule, that's ~30M domain slots — far more than any realistic subscription stack will use. The real constraint is list size: a single list with millions of entries needs to fit within budget alongside other subscribed lists.

The 5,000 unsafe dynamic rule limit doesn't apply here since plain `block` and `redirect` rules are safe.

## Architecture

Three layers, all inside the extension:

1. **Subscription manager** — persists list subscriptions (URL, last-fetched, etag, status) in `chrome.storage.local`
2. **Fetch + parse pipeline** — runs in the service worker on schedule, downloads lists, parses them, normalizes domains, packs into rules
3. **Rule applier** — atomically swaps dynamic rules for each subscription using ID namespacing so subscriptions don't trample each other

## Project layout

```
nsfw-blocker/
├── manifest.json
├── background.js              # service worker entrypoint
├── lib/
│   ├── parsers.js             # hosts and adblock parsers + host validator
│   ├── normalize.js           # host validation + redundant-subdomain pruning
│   ├── packer.js              # domains → DNR rules
│   ├── subscriptions.js       # CRUD on subscriptions in storage
│   └── rules.js               # apply/remove rule batches by namespace
├── pages/
│   ├── blocked.html
│   ├── blocked.js
│   ├── options.html
│   ├── options.js
│   └── styles.css
├── icons/
│   └── icon-{16,48,128}.png
└── package.json               # for dev tooling only
```

## Storage shape

`chrome.storage.local` keys:

```js
{
  subscriptions: [
    {
      id: "sub_abc123",          // generated; used as rule ID namespace
      name: "OISD NSFW",          // user-supplied display name
      url: "https://big.oisd.nl/nsfw",
      enabled: true,
      lastFetched: 1716600000000,
      etag: "abc-123",
      lastModified: "Mon, ...",
      lastResult: { ok: true, domainCount: 142331, ruleCount: 285 },
      lastError: null
    },
    {
      id: "sub_xyz789",
      name: "OISD small",
      url: "https://small.oisd.nl/nsfw",
      enabled: true,
      ...
    }
  ],
  personalBlocks: "example.com\nanother.com\n# my notes\nthird.com",
  settings: {
    fetchIntervalDays: 1,         // 1-7 or "manual"
    blockPageMessage: "This page is blocked.",
    settingsLocked: false
  }
}
```

`personalBlocks` is a separate top-level string (raw textarea contents), not a subscription. It gets its own reserved rule ID range (a fixed slice, since there's only one of it) and is reparsed and rebuilt whenever the user saves changes. Keeping it out of `subscriptions` makes the data model cleaner — subscriptions always have URLs, personal blocks never do, so the two never get confused in code or in backup exports. Storing the raw text rather than a parsed array preserves comments, blank lines, and ordering between sessions.

Each subscription owns a slice of the dynamic rule ID space. With 32-bit-ish IDs, give each subscription 1,000,000 IDs starting at `subscriptionIndex * 1_000_000`. Rule replacement for one subscription touches only its slice.

## Parsing

### Hosts format

```
# comment
0.0.0.0 example.com
127.0.0.1 ads.example.org
0.0.0.0 tracker.example.net # inline comment
```

Parser logic: for each line, strip inline `#` comments, split on whitespace. If the first token is an IP and there's a second token, take the second token as the domain. Plain-domain-per-line is also accepted (some lists ship that way).

```js
// lib/parsers.js
export function parseHosts(text) {
  const domains = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    let candidate;
    if (parts.length === 1) {
      candidate = parts[0]; // plain domain list
    } else if (/^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0])) {
      candidate = parts[1]; // hosts file
    } else {
      continue; // skip unknown shapes
    }

    if (isValidDomain(candidate)) domains.add(candidate.toLowerCase());
  }
  return domains;
}
```

### Adblock format

Supported subset (everything else is skipped with a counter for the user's "skipped X lines" report):

All supported syntaxes map to the same subtree `requestDomains` condition —
there is no apex-only mapping (see "Matching model").

| Syntax                     | Meaning                          | DNR mapping                       |
| -------------------------- | -------------------------------- | --------------------------------- |
| `\|\|example.com^`         | Block domain and all subdomains  | `requestDomains: ["example.com"]` |
| `\|\|example.com`          | Same as above (`^` optional)     | `requestDomains: ["example.com"]` |
| `example.com`              | Plain domain — treated as subtree | `requestDomains: ["example.com"]` |
| `@@\|\|example.com^`       | Allow (exception), subtree       | `allow` action, higher priority   |
| `! comment` or `# comment` | Comment                          | skip                              |
| `[Adblock Plus 2.0]`       | Header                           | skip                              |

Note that a plain `example.com` line is treated identically to `||example.com^`
— both block the domain and all subdomains. v1 treated the plain form as
apex-only; v2 does not.

Explicitly **not** supported in v1 (skip with warning):

- Cosmetic filters (`##`, `#@#`, `#?#`, `#$#`)
- Scriptlet injection (`+js(...)`)
- Resource-type modifiers (`$script`, `$image`, etc.) — treated as plain domain rules, modifiers stripped
- URL path patterns — only domain-level rules accepted
- Regex rules (`/regex/`)

```js
export function parseAdblock(text) {
  const block = new Set();
  const allow = new Set();
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("!") ||
      line.startsWith("#") ||
      line.startsWith("[")
    )
      continue;

    // Cosmetic filter — skip
    if (line.includes("##") || line.includes("#@#") || line.includes("#?#")) {
      skipped++;
      continue;
    }

    const isException = line.startsWith("@@");
    const body = isException ? line.slice(2) : line;

    // Strip modifiers ($script, $third-party, etc.)
    const beforeDollar = body.split("$")[0];

    // Match ||domain^ or ||domain or plain domain
    const match =
      beforeDollar.match(/^\|\|([a-z0-9.\-_]+)\^?$/i) ||
      beforeDollar.match(/^([a-z0-9.\-_]+)$/i);
    if (!match) {
      skipped++;
      continue;
    }

    const domain = match[1].toLowerCase();
    if (!isValidDomain(domain)) {
      skipped++;
      continue;
    }

    (isException ? allow : block).add(domain);
  }

  return { block, allow, skipped };
}
```

Allow rules need a higher-priority `allow` action than block rules. The packer needs to emit those separately. For v1 this is a minor extension; for users mostly subscribing to NSFW blocklists, the allow-rule path will rarely be exercised but should still work.

### Format auto-detection

The extension never asks the user what format a list is in. On every fetch, the parser sniffs the content and picks the right path. The sniffer:

1. Scans the first ~200 non-comment, non-blank lines
2. Counts lines that match each format's distinctive markers:
   - Adblock signals: starts with `||`, `@@||`, `[Adblock`, contains `##`/`#@#`, ends with `^`, contains `$` modifiers
   - Hosts signals: starts with `0.0.0.0 `, `127.0.0.1 `, `::1 `, or matches `<IP> <domain>` shape
   - Plain domain signals: bare domain per line (no whitespace, no `||`, no IPs)
3. Picks the format with the highest signal count
4. Falls back to hosts (which also handles plain-domain lists) when signals are tied or absent

```js
// lib/parsers.js
export function sniffFormat(text) {
  let adblock = 0,
    hosts = 0,
    plain = 0;
  let scanned = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    if (scanned >= 200) break;
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("!") ||
      line.startsWith("[")
    ) {
      // [Adblock Plus 2.0] header is a strong adblock signal even though it's a "comment"
      if (/^\[adblock/i.test(line)) adblock += 5;
      continue;
    }
    scanned++;

    if (/^\|\||^@@\|\||##|#@#|#\?#/.test(line)) adblock++;
    else if (/^(0\.0\.0\.0|127\.0\.0\.1|::1?)\s+\S/.test(line)) hosts++;
    else if (/^[a-z0-9.\-_]+$/i.test(line)) plain++;
  }

  if (adblock > hosts && adblock > plain) return "adblock";
  if (hosts > 0) return "hosts";
  return "hosts"; // hosts parser also accepts plain-domain lists
}
```

The detected format isn't surfaced in the UI — the user shouldn't have to care, and showing it invites questions that lead nowhere useful. If detection is ever wrong on a real list (zero domains imported from a list the user knows is valid), that's a parser bug to fix, not a knob for the user.

## Normalization

After parsing, regardless of source format, each host is validated and
canonicalized **but not reduced to its registrable domain**:

1. Lowercase, strip a trailing dot, reject anything with whitespace, `/`, or `:`
2. Convert IDNs to ASCII (punycode) via the `URL` constructor
3. Drop entries that fail DNS-label validation (IPs, localhost, single-label
   names, over-length labels, invalid characters)
4. Deduplicate via `Set`

```js
// lib/normalize.js — thin wrapper over the parser's host validator
import { normalizeHostname } from "./parsers.js";

export function normalize(rawDomains) {
  const out = new Set();
  for (const d of rawDomains) {
    const host = normalizeHostname(d); // lowercase, punycode, validate
    if (host && host.includes(".")) out.add(host);
  }
  return out;
}
```

### Why no eTLD+1 reduction

The earlier draft reduced every host to its registrable domain with
`tldts.getDomain()`. Under subtree matching that step is **all cost, no
benefit**:

- Subtree matching on `example.com` already covers `www/cdn/m.example.com`, so
  eTLD+1 reduction is not needed to catch subdomains.
- The only thing reduction adds is widening a subdomain-specific entry **up** to
  its parent — e.g. a list that deliberately blocks `tracker.shady-cdn.com`
  would be silently widened to block all of `shady-cdn.com`, including domains
  the author chose not to list.

So hosts are keyed as written. This also removes the `vendor/tldts.min.js`
dependency from the project layout — drop that file and its import. The Lookup
tab still needs to answer "what would happen for this domain," but with subtree
matching that's a parent-suffix walk (does any ancestor of the query appear in a
rule's `requestDomains`?), which needs no public-suffix list either. See the
Lookup section.

### Pruning redundant subdomains

Because matching is subtree, any listed host whose parent is also listed is
redundant: `www.example.com` is already covered by `example.com`. After
collecting the block set, drop every host that has an ancestor in the same set
before packing. This shrinks the rule count for messy hosts files and is purely
an optimization — it never changes what gets blocked.

## Packing

Per subscription, after normalization:

```js
// lib/packer.js
const PACK_SIZE = 1000;
const SAFE_RESOURCE_TYPES = [
  "sub_frame",
  "script",
  "image",
  "media",
  "xmlhttprequest",
  "stylesheet",
  "font",
  "object",
  "ping",
  "other",
];

export function packSubscription(domains, allowDomains, idBase) {
  const sorted = [...domains].sort();
  const allowSorted = [...allowDomains].sort();
  const rules = [];
  let id = idBase;

  // Allow rules come first (higher priority)
  for (let i = 0; i < allowSorted.length; i += PACK_SIZE) {
    const batch = allowSorted.slice(i, i + PACK_SIZE);
    rules.push({
      id: id++,
      priority: 10,
      action: { type: "allow" },
      condition: {
        requestDomains: batch,
        resourceTypes: ["main_frame", ...SAFE_RESOURCE_TYPES],
      },
    });
  }

  // Block rules: redirect for top-level, block for subresources
  for (let i = 0; i < sorted.length; i += PACK_SIZE) {
    const batch = sorted.slice(i, i + PACK_SIZE);

    rules.push({
      id: id++,
      priority: 2,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/pages/blocked.html" },
      },
      condition: { requestDomains: batch, resourceTypes: ["main_frame"] },
    });

    rules.push({
      id: id++,
      priority: 1,
      action: { type: "block" },
      condition: { requestDomains: batch, resourceTypes: SAFE_RESOURCE_TYPES },
    });
  }

  return rules;
}
```

## Applying rules atomically

Per-subscription rule replacement:

```js
// lib/rules.js
export async function replaceSubscriptionRules(subscriptionId, newRules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const { startId, endId } = idRangeFor(subscriptionId);
  const toRemove = existing
    .filter((r) => r.id >= startId && r.id <= endId)
    .map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: toRemove,
    addRules: newRules,
  });
}

function idRangeFor(subscriptionId) {
  const index = subscriptionIndexFromStorage(subscriptionId);
  return { startId: index * 1_000_000, endId: (index + 1) * 1_000_000 - 1 };
}
```

The DNR update is atomic — old rules for this subscription are removed and new ones added in one operation. Other subscriptions are untouched.

## Fetch lifecycle

```js
// background.js (excerpt)

async function refreshSubscription(sub) {
  if (!sub.url) return;

  try {
    const headers = {};
    if (sub.etag) headers["If-None-Match"] = sub.etag;
    if (sub.lastModified) headers["If-Modified-Since"] = sub.lastModified;

    const res = await fetch(sub.url, { headers });
    if (res.status === 304) {
      await updateSub(sub.id, { lastFetched: Date.now() });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    await applyListText(sub, text);

    await updateSub(sub.id, {
      lastFetched: Date.now(),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      lastError: null,
    });
  } catch (err) {
    await updateSub(sub.id, { lastError: String(err) });
    // Leave existing rules in place — fail-closed for the user's protection
  }
}

async function applyListText(sub, text) {
  const format = sniffFormat(text);
  const parsed =
    format === "adblock"
      ? parseAdblock(text)
      : { block: parseHosts(text), allow: new Set(), skipped: 0 };

  const normalized = normalize(parsed.block);
  const normalizedAllow = normalize(parsed.allow);

  const rules = packSubscription(
    normalized,
    normalizedAllow,
    idRangeFor(sub.id).startId,
  );

  // Check budget before applying
  const available =
    (await chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES) -
    (await currentRuleCountExcluding(sub.id));
  if (rules.length > available) {
    throw new Error(
      `List has ${rules.length} rules, only ${available} slots available`,
    );
  }

  await replaceSubscriptionRules(sub.id, rules);
  await updateSub(sub.id, {
    lastResult: {
      ok: true,
      domainCount: normalized.size,
      ruleCount: rules.length,
      skipped: parsed.skipped,
    },
  });
}
```

Scheduling:

```js
// On install and whenever the interval setting changes, recreate the alarm
async function rescheduleAlarm() {
  await chrome.alarms.clear("refreshAll");
  const { settings } = await chrome.storage.local.get("settings");
  if (settings.fetchIntervalDays === "manual") return; // no alarm at all
  // Fire once a day; per-subscription staleness check inside the handler
  chrome.alarms.create("refreshAll", { periodInMinutes: 60 * 24 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "refreshAll") return;
  const { settings } = await chrome.storage.local.get("settings");
  if (settings.fetchIntervalDays === "manual") return;

  const intervalMs = settings.fetchIntervalDays * 24 * 3600 * 1000;
  const subs = await getSubscriptions();
  const now = Date.now();
  for (const sub of subs) {
    if (!sub.enabled) continue;
    if (now - (sub.lastFetched || 0) >= intervalMs) {
      await refreshSubscription(sub);
    }
  }
});
```

The alarm fires daily but each subscription only refetches when its own interval has elapsed — so with a 7-day setting on a list that was just fetched yesterday, the alarm wakes up but does nothing. Manual mode skips the alarm entirely; lists only update via Update all or by editing a subscription.

## Options page

Four tabs:

**1. Subscriptions**

A stats header at the top of the tab shows two numbers at a glance:

- **Total domains blocked** — the sum of normalized domain counts across all enabled subscriptions plus personal blocks. Gives the user a single "this is how much I'm blocking" number.
- **Last built** — the most recent timestamp at which any subscription's rules were successfully applied. Answers "when was the blocklist last refreshed?" without making the user scan every card.

Both numbers update live as subscriptions finish refreshing during an Update all run.

Below the stats, a header row with a single **Update all** button — refetches every enabled subscription in parallel (with a small concurrency cap, e.g. 4 at a time, to avoid hammering hosts). Disabled subscriptions are skipped. A spinner on the button while in progress; per-row results land back in the table as they finish.

Subscriptions render as a table, one row per subscription:

| Column  | Contents                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------- |
| Enabled | Toggle switch                                                                                  |
| Name    | User-supplied display name                                                                     |
| Domains | Domain count (e.g. `142,331`), or `—` if never fetched, or an error icon if `lastError` is set |
| Actions | Edit and Remove buttons (icon-only to keep the column narrow)                                  |

The Domains column carries the at-a-glance state — how much this list is blocking, and whether it's broken. The error icon has a tooltip with the error summary so users can spot broken subscriptions without expanding anything.

Rows expand inline on click to reveal the details that aren't part of at-a-glance status: URL, last fetched timestamp, rule count, skipped-line count from the last parse, and the full error text if any. Detected format is intentionally not shown — the user shouldn't have to care, and surfacing it invites questions that lead nowhere useful. Only one row expands at a time to keep the table from sprawling.

Sortable headers on Name and Domains. Default sort is by Name ascending. The user's sort preference persists in `settings` so it survives reloads.

Actions:

- **Edit** — opens the same modal used for adding, pre-filled with the subscription's current values. Saving the modal updates the subscription and triggers an immediate refetch. This replaces the older "Refresh now" button — refreshing is no longer a separate action since editing always reapplies, and a global Update all covers the case where nothing changed locally.
- **Remove** — deletes the subscription and clears its rule slice (with a confirmation prompt).

"+ Add subscription" button opens a modal:

- Name
- URL (HTTPS required)

URL is the only source type — no pasted text. If a user wants a personal list, the Personal blocks tab is the right path. Keeping subscriptions URL-only means every subscription has a canonical remote source that can be re-fetched, which makes Update all and the export-import flow trivially correct.

**2. Personal blocks**

A single textarea, one domain per line. The user edits freely — adding, removing, reordering, pasting bulk lists from elsewhere — and clicks **Save** to apply. Empty lines and lines starting with `#` are ignored, so users can keep comments or section breaks in their own notes. The textarea is backed by the top-level `personalBlocks` string in storage (raw text, not a parsed array), preserving the user's exact formatting between sessions.

On save:

1. Parse the textarea — split on newlines, strip comments and blanks, trim whitespace
2. Validate and canonicalize each entry (lowercase, punycode, DNS-label check), dropping invalid domains (with a "12 entries weren't valid domains and were ignored" notice if any get dropped). Entries are kept as written — not reduced to their registrable domain — and match subtree like every other rule.
3. Deduplicate, then prune any host whose parent is also present
4. Pack into rules and atomically replace the personal-blocks rule slice

Below the textarea, a status line shows last-saved time, the domain count after normalization, and any validation warnings from the most recent save.

This is friendlier than a list-of-rows UI for the common case of "I want to add a bunch of domains at once" — the user pastes a block of text and saves, instead of clicking Add fifty times. It also gives the user a single place to see and edit everything they've personally blocked, which matches how they'd think about it.

**3. Lookup**

A debugging surface for "why is this domain (not) blocked?" The user types a domain into a search box and sees the resulting verdict plus the reasoning behind it.

Output for a query like `example.com`:

- **Verdict**: `Allowed` / `Blocked (redirected to block page)` / `Blocked (subresource only)` / `Not in any list`
- **Blocking subscriptions**: list of subscriptions whose block rules match, with a click-through to that subscription's card
- **Allowing subscriptions**: list of subscriptions whose `@@||` exception rules match, also click-through
- **Effective rule**: the highest-priority rule that wins (allow rules at priority 10 beat block/redirect at 1–2, so any allow match means `Allowed`)
- **Matched host**: shows which host in the rule set the query matched against, since a query for `cdn.m.example.com` can be caught by a rule keyed on `example.com` (subtree). This is the ancestor that actually matched, not a registrable-domain reduction.

Implementation note: Chrome's `chrome.declarativeNetRequest.testMatchOutcome()` would be the authoritative source — it's exactly what the browser uses at request time — but it's documented as available only for unpacked extensions, intended for development. For a production extension we can't use it, so the lookup tab re-implements the relevant matching logic itself by walking the dynamic rule set.

The matching logic for domain-level rules is simple enough to redo. Because rules match subtree (`requestDomains` matches the listed host and all subdomains), a rule matches the query if the query equals, or is a subdomain of, any host in `requestDomains` — i.e. if any parent-suffix of the query appears in the rule. No public-suffix list is needed; we just walk the query's own labels. Pick the highest-priority match per resource type. Sketch:

```js
// All parent-suffixes of a host, longest first:
// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"]
function hostSuffixes(host) {
  const labels = host.split(".");
  const out = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
}

async function lookupDomain(input) {
  const host = normalizeHostname(input);
  if (!host || !host.includes(".")) return { error: "Not a valid domain" };
  const suffixes = hostSuffixes(host);

  const allRules = await chrome.declarativeNetRequest.getDynamicRules();
  const matching = allRules.filter(
    (r) =>
      r.condition.requestDomains?.some((d) => suffixes.includes(d)) &&
      !r.condition.excludedRequestDomains?.some((d) => suffixes.includes(d)),
  );

  // Group by resource type bucket and pick the winner per bucket
  const mainFrameWinner = pickWinner(matching, "main_frame");
  const subresourceWinner = pickWinner(matching, "image"); // proxy for any subresource

  // Attribute back to subscriptions via the ID-range scheme
  const blocking = new Set();
  const allowing = new Set();
  for (const r of matching) {
    const subId = subscriptionIdForRuleId(r.id);
    if (r.action.type === "allow") allowing.add(subId);
    else blocking.add(subId);
  }

  return {
    normalized: domain,
    verdict: deriveVerdict(mainFrameWinner, subresourceWinner),
    blocking: [...blocking],
    allowing: [...allowing],
  };
}

function pickWinner(rules, resourceType) {
  const applicable = rules.filter(
    (r) =>
      !r.condition.resourceTypes ||
      r.condition.resourceTypes.includes(resourceType),
  );
  if (!applicable.length) return null;
  // DNR ordering: by priority desc, then allow > block > redirect within same priority
  const actionRank = {
    allow: 3,
    allowAllRequests: 3,
    block: 2,
    redirect: 1,
    upgradeScheme: 1,
  };
  applicable.sort((a, b) => {
    const p = (b.priority ?? 1) - (a.priority ?? 1);
    if (p !== 0) return p;
    return (actionRank[b.action.type] ?? 0) - (actionRank[a.action.type] ?? 0);
  });
  return applicable[0];
}
```

This isn't a perfect replica of Chrome's matcher — it ignores static rules (there are none in this design), URL filter patterns (we don't use them), and a few other DNR features we don't touch — but for a domain-only design it produces the correct answer for every rule the extension actually emits. The function `subscriptionIdForRuleId` is the inverse of `idRangeFor`: divide by 1,000,000 and look up the subscription whose index matches.

This becomes the answer to "why is this domain loading despite being on my list" — the lookup will surface the allow rule that's overriding it and which subscription it came from, so the user can either remove that subscription or accept the override.

**4. Settings**

- Fetch interval: dropdown with options `Manual`, `1 day`, `2 days`, `3 days`, `4 days`, `5 days`, `6 days`, `7 days`. Default is `1 day`. `Manual` disables the periodic refresh entirely — lists only update when the user clicks Update all or edits a subscription.
- Block page message (customizable)
- Optional settings lock (password gate for the options page)
- Export/import all subscriptions as JSON

## Manifest

```json
{
  "manifest_version": 3,
  "name": "Domain Blocker",
  "version": "1.0.0",
  "description": "Block domains using your own hosts or adblock-format lists.",
  "permissions": ["declarativeNetRequest", "storage", "alarms"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "pages/options.html" },
  "web_accessible_resources": [
    {
      "resources": [
        "pages/blocked.html",
        "pages/blocked.js",
        "pages/styles.css"
      ],
      "matches": ["<all_urls>"]
    }
  ],
  "options_page": "pages/options.html",
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

No `declarative_net_request.rule_resources` key — everything is dynamic. No static rulesets means nothing to ship in the extension package beyond code.

`host_permissions: ["<all_urls>"]` is required to `fetch()` arbitrary user-supplied list URLs. This will generate an install-time permission warning ("Read your data on all websites"), which is unavoidable when users can subscribe to any URL. The options page should explain this up front.

## Error handling and user feedback

This is where the v2 design needs to be more careful than v1, because parsing untrusted user-supplied lists can fail in many ways. The options page must surface:

- **HTTP failures** ("Couldn't fetch list: HTTP 404 — check the URL")
- **Parse warnings** ("Imported 142,331 domains. Skipped 1,847 lines that weren't recognized.")
- **Quota errors** ("This list has 1.2M domains, but only 800k slots are available across all your subscriptions. Try removing other lists.")
- **Validation drops** ("12 entries were not valid domains and were ignored.")

Users adding their own lists need to know what happened. Don't fail silently.

## Block page

Same as v1 — friction-positive, easy way back, link to options. One addition: include the user-customizable message from `settings.blockPageMessage` so users can write themselves a note for future-them ("You blocked this for a reason. Take a breath.").

There is no "close tab" block action. v1 offered a `blockAction` setting that could close the tab instead of showing the block page; v2 drops it. A top-level block is a `redirect` rule to `blocked.html`, which is purely declarative — DNR has no action that closes a tab, and adding one back would require the exact `webNavigation` + `tabs.remove` runtime interception the rewrite exists to eliminate. The friction-positive block page is also the better accountability surface than a silently vanishing tab. (Note: the off-the-record incognito edge case that forced a tab close in v1 — an on-the-record extension page can't load in an off-the-record tab — does not arise here, since DNR redirects are applied by the browser regardless of profile.)

## Trust and security considerations

Letting users subscribe to arbitrary URLs introduces a small surface:

- **Malicious lists** could try to block domains the user needs (banks, email). Mitigate with: clear domain counts before applying, easy disable/remove, a "blocked domain lookup" feature in the options page so the user can check why something isn't loading.
- **HTTPS only.** Reject `http://` list URLs to prevent network-level tampering. Show an error in the UI.
- **Resource limits.** Cap list size at, say, 50MB downloaded text. Refuse larger fetches. Cap rule count per subscription so one runaway list can't consume the whole budget — say, 25,000 rules max per subscription, leaving 5,000 for other subscriptions plus personal blocks.

## Testing plan

1. **Parser unit tests** — golden inputs for hosts and adblock formats, including edge cases (inline comments, IPv6 hosts entries, modifier suffixes, cosmetic filters, exception rules)
2. **Normalization tests** — IP rejection, localhost rejection, internationalized domains (punycode), and redundant-subdomain pruning (a host whose parent is also present is dropped); confirm hosts are *not* reduced to their registrable domain
3. **End-to-end** — subscribe to a small public list (e.g., 100-domain hosts file hosted as a gist), verify rules apply, verify blocked domains redirect, verify allowed domains load
4. **Update flow** — subscribe, modify the list source, refresh, verify old rules are gone and new ones applied
5. **Conflict handling** — two subscriptions that overlap on domains; should be fine since rules just duplicate harmlessly
6. **Budget edge** — subscribe to a list near the rule limit, then try to add another; verify clean error rather than silent failure

## Release checklist

- [ ] Parsers handle malformed input without crashing the service worker
- [ ] Storage migrations planned (versioning the storage schema from day one)
- [ ] Permission warning explained in the install description
- [ ] Block page renders without subscriptions loaded (fresh install case)
- [ ] Options page works when storage is empty
- [ ] Tested with one real-world public list end-to-end

## Design decisions

These were open during planning and have been settled:

1. **No `file://` URL subscriptions.** Only HTTPS URLs. Avoids local-file access surface.
2. **Export is URLs only.** Backup/import covers subscription URLs and settings, not the parsed rules. The user's lists rehydrate from source on import, which is simpler and self-healing — a stale exported ruleset would be worse than refetching.
3. **No pre-bundled default subscriptions.** The extension ships empty. Users pick their own lists. Avoids any appearance of endorsement and keeps the extension neutral about what to block.
4. **Allow rules cross subscription boundaries.** An `@@||example.com^` exception in any subscription overrides block rules from any other subscription, because allow rules use priority 10 and block/redirect use priority 1-2 — and DNR evaluates priority globally across all dynamic rules. This matches user expectation: if you explicitly allow a domain anywhere, it stays allowed everywhere.
5. **Subtree-only matching; no exact-host rules and no eTLD+1 reduction.** Every rule matches a host and all its subdomains via `requestDomains`, keyed on the host as written. Exact (apex-only) matching is dropped because the only DNR condition that achieves it (`urlFilter`) can't batch and would blow the 30k rule limit on large lists. eTLD+1 reduction is dropped because, under subtree matching, it adds nothing (subdomains are already covered) and only risks over-blocking by widening subdomain-specific entries up to their registrable parent. See "Matching model" and "Normalization". This is the one place v2 behavior diverges from v1, which matched exact by default.
6. **No "close tab" block action.** v1's `blockAction` setting could close the tab on a block; v2 always redirects to the block page. DNR has no tab-closing action, and reintroducing one would require the `webNavigation` + `tabs.remove` runtime interception the rewrite is built to remove. The block page is also the better accountability surface. See "Block page".
