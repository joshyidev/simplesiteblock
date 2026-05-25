# Host index encoding

How the compiled blocking index is represented, stored, and queried. The
implementation lives in `src/background/engine.js`; storage glue is in
`src/background/storage.js`.

## What the index holds

Blocking is host-only. The index is four sorted sets of hostnames, matching the
rule model in `AGENTS.md`:

- `hostBlocksExact` — block this exact host (`example.com` blocks only
  `example.com`).
- `hostAllowsExact` — allow this exact host (`@@example.com`).
- `hostBlocksSubtree` — block host + subdomains (`||example.com^`).
- `hostAllowsSubtree` — allow host + subdomains (`@@||example.com^`).

`evaluate(url, index)` checks them in precedence order: allow-exact,
allow-subtree, block-exact, block-subtree. Allow always wins over block.

Hostnames are expected to be lowercase (the hosts/Adblock parsers normalize
them), and lookups lowercase the query, so matching is case-insensitive.

## Two representations

The index exists in two forms:

1. **Serialized** — what is written to `chrome.storage.local` under
   `compiledIndex`. Each bucket is a single **sorted, newline-joined string**.
2. **Hydrated** — what the service worker holds in memory and queries. Each
   bucket is `{ blob, offsets }`: the same string plus an `Int32Array` of
   line-start positions for binary search.

```
serialized bucket:  "a.example\nb.example\nc.example"
hydrated bucket:    { blob: "a.example\nb.example\nc.example",
                      offsets: Int32Array [0, 10, 20] }
```

The shape:

```
EMPTY_SERIALIZED_INDEX = {
  hostBlocksExact: "",
  hostAllowsExact: "",
  hostBlocksSubtree: "",
  hostAllowsSubtree: "",
  builtAt: 0,
}
```

## Why this encoding

The earlier encoding stored each bucket as a JS array of host strings. At ~800k
hosts that means ~800k individual string objects plus an array of pointers —
heavy in memory and slow to deserialize when the (ephemeral MV3) service worker
cold-starts.

The packed form stores one flat string per bucket plus one typed array. For an
all-ASCII host list V8 keeps the blob as a one-byte string, so the bucket is
roughly "raw host text + 4 bytes per host" instead of per-object overhead times
800k. Measured effect on one 800k-rule profile: worker heap ~32.5MB -> ~22MB.
The bigger win is cold-start load: parsing one big string and scanning it once
is far cheaper than constructing 800k string objects, which shortens the time
before the worker can answer.

It is **lossless** — the real hostnames are preserved (unlike a hashed-set
encoding), so there is no false-positive risk. That matters for this project.

## Building and serializing

`createCombinedIndex(parsedLists)` unions the per-list parser output into four
`Set`s (dedup happens here), then `serializeIndex` packs each set:

```js
function packHosts(hosts) {
  if (typeof hosts === "string") return hosts; // already packed
  return [...(hosts || [])].sort().join("\n");
}
```

`Array.prototype.sort()` orders by UTF-16 code unit. This order is the contract
the lookup depends on (see below). Newline (`\n`) is a safe delimiter because
hostnames never contain one.

## Hydrating

`hydrateBucket` turns a blob into `{ blob, offsets }` in two passes — count the
newlines, allocate the `Int32Array`, then fill it — to avoid building a throwaway
intermediate array:

```js
function hydrateBucket(blob) {
  if (typeof blob !== "string" || blob === "") {
    return { blob: "", offsets: new Int32Array(0) };
  }
  let count = 1;
  for (let i = 0; i < blob.length; i += 1) {
    if (blob.charCodeAt(i) === 10) count += 1; // 10 === '\n'
  }
  const offsets = new Int32Array(count);
  let idx = 1;
  for (let i = 0; i < blob.length; i += 1) {
    if (blob.charCodeAt(i) === 10) {
      offsets[idx] = i + 1;
      idx += 1;
    }
  }
  return { blob, offsets };
}
```

`offsets[k]` is the start index of line `k`. `offsets[0]` is always 0; each
subsequent entry is the character right after a newline. There is no trailing
newline, so line `k` spans `[offsets[k], offsets[k+1] - 1)`, and the last line
ends at `blob.length`.

## Looking up a host

`matchesHostExact(bucket, host)` lowercases and binary-searches; `bucketHas` does
the search:

```js
function bucketHas(bucket, target) {
  const offsets = bucket.offsets;
  if (!offsets || offsets.length === 0) return false;
  let low = 0,
    high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cmp = compareLineAt(bucket.blob, offsets, mid, target);
    if (cmp === 0) return true;
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}
```

`compareLineAt` compares the line at `offsets[mid]` against `target` **in place**
(no substring allocation per probe), by UTF-16 code unit so it matches the sort
order used in `packHosts`. A line that is a strict prefix of `target` sorts
before it, and vice versa:

```js
function compareLineAt(blob, offsets, i, target) {
  let p = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] - 1 : blob.length;
  let t = 0;
  while (p < end && t < target.length) {
    const a = blob.charCodeAt(p),
      b = target.charCodeAt(t);
    if (a !== b) return a - b;
    p += 1;
    t += 1;
  }
  const lineRemaining = end - p;
  const targetRemaining = target.length - t;
  if (lineRemaining === 0 && targetRemaining === 0) return 0;
  return lineRemaining > 0 ? 1 : -1;
}
```

Subtree matching reuses exact lookups. `matchesHostSubtree` walks the query's
parent suffixes and probes each (e.g. `a.b.example.com` -> `a.b.example.com`,
`b.example.com`, `example.com`, `com`), so a single subtree entry covers all
subdomains without storing them.

## Counting

`countIndexRules` sums the host count of each bucket; `countHosts` counts lines
(newlines + 1, or 0 for an empty blob). This feeds the displayed rule total.

## Storage and stats

`saveCompiledIndex` writes the serialized index and a small summary together:

```js
ext.storage.local.set({
  compiledIndex,
  indexStats: { total, builtAt },
  pendingRebuild: false,
});
```

`indexStats` is tiny and lets the options page show the rule count / build time
without deserializing the whole index.

On startup, `service_worker.js` rebuilds only when no index has ever been built:

```js
if (!state.indexStats.builtAt) await compileAndStoreIndex();
```

There is no index-format versioning. If the encoding itself changes before
release, a previously stored index may hydrate incorrectly and is not
auto-rebuilt, so clear extension storage or trigger a manual rebuild after the
change. This is acceptable while the extension is pre-release; add a stored
format/version check before shipping if future installs need automatic migration.

## Invariants

- Each bucket blob is **sorted by UTF-16 code unit** and newline-joined; lookups
  depend on this order.
- Hosts are stored lowercase (parser-normalized); queries are lowercased.
- No host contains a newline, so `\n` is an unambiguous delimiter; no empty
  lines (no trailing newline).
- The index is a **derived cache** rebuilt from `rawLists` + `customRules`. It is
  never exported (settings exports omit it) and can always be regenerated.
