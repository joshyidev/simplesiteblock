// Host index representation. Each bucket is stored as a single newline-joined,
// sorted string ("blob") rather than an array of host strings. Hydration builds
// an Int32Array of line-start offsets and membership is a binary search over
// those offsets. This keeps one flat string + one typed array per bucket
// instead of hundreds of thousands of individual JS strings, which is far
// cheaper in memory and much faster to deserialize on a cold service worker.
export const EMPTY_SERIALIZED_INDEX = Object.freeze({
  hostBlocksExact: "",
  hostAllowsExact: "",
  hostBlocksSubtree: "",
  hostAllowsSubtree: "",
  builtAt: 0,
});

export function hydrateIndex(serialized = EMPTY_SERIALIZED_INDEX) {
  return {
    hostBlocksExact: hydrateBucket(serialized.hostBlocksExact),
    hostAllowsExact: hydrateBucket(serialized.hostAllowsExact),
    hostBlocksSubtree: hydrateBucket(serialized.hostBlocksSubtree),
    hostAllowsSubtree: hydrateBucket(serialized.hostAllowsSubtree),
    builtAt: serialized.builtAt || 0,
  };
}

export function serializeIndex(index) {
  return {
    hostBlocksExact: packHosts(index.hostBlocksExact),
    hostAllowsExact: packHosts(index.hostAllowsExact),
    hostBlocksSubtree: packHosts(index.hostBlocksSubtree),
    hostAllowsSubtree: packHosts(index.hostAllowsSubtree),
    builtAt: index.builtAt || Date.now(),
  };
}

export function countIndexRules(index = EMPTY_SERIALIZED_INDEX) {
  return (
    countHosts(index.hostBlocksExact) +
    countHosts(index.hostAllowsExact) +
    countHosts(index.hostBlocksSubtree) +
    countHosts(index.hostAllowsSubtree)
  );
}

export function createCombinedIndex(parsedLists) {
  const combined = {
    hostBlocksExact: new Set(),
    hostAllowsExact: new Set(),
    hostBlocksSubtree: new Set(),
    hostAllowsSubtree: new Set(),
    builtAt: Date.now(),
  };

  for (const parsed of parsedLists) {
    for (const host of parsed.hostBlocksExact || [])
      combined.hostBlocksExact.add(host);
    for (const host of parsed.hostAllowsExact || [])
      combined.hostAllowsExact.add(host);
    for (const host of parsed.hostBlocksSubtree || [])
      combined.hostBlocksSubtree.add(host);
    for (const host of parsed.hostAllowsSubtree || [])
      combined.hostAllowsSubtree.add(host);
  }

  return serializeIndex(combined);
}

export function evaluate(url, index) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { blocked: false };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { blocked: false };
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (matchesHostExact(index.hostAllowsExact, host)) return { blocked: false };
  if (matchesHostSubtree(index.hostAllowsSubtree, host))
    return { blocked: false };

  if (matchesHostExact(index.hostBlocksExact, host)) {
    return { blocked: true, reason: `host-exact:${host}` };
  }

  if (matchesHostSubtree(index.hostBlocksSubtree, host)) {
    return { blocked: true, reason: `host-subtree:${host}` };
  }

  return { blocked: false };
}

export function matchesHostExact(bucket, host) {
  if (!bucket || !host) return false;
  return bucketHas(bucket, host.toLowerCase());
}

export function matchesHostSubtree(bucket, host) {
  if (!bucket || !host) return false;
  const labels = host.toLowerCase().split(".");
  for (let index = 0; index < labels.length; index += 1) {
    if (bucketHas(bucket, labels.slice(index).join("."))) return true;
  }
  return false;
}

// --- internal: packed-string bucket representation ---

function packHosts(hosts) {
  if (typeof hosts === "string") return hosts; // already packed
  return [...(hosts || [])].sort().join("\n");
}

function hydrateBucket(blob) {
  if (typeof blob !== "string" || blob === "") {
    return { blob: "", offsets: new Int32Array(0) };
  }
  // Two passes (count, then fill) avoid building a throwaway JS array, keeping
  // cold-start hydration cheap.
  let count = 1;
  for (let i = 0; i < blob.length; i += 1) {
    if (blob.charCodeAt(i) === 10 /* \n */) count += 1;
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

function countHosts(blob) {
  if (typeof blob !== "string" || blob === "") return 0;
  let count = 1;
  for (let i = 0; i < blob.length; i += 1) {
    if (blob.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function bucketHas(bucket, target) {
  const offsets = bucket.offsets;
  if (!offsets || offsets.length === 0) return false;
  const blob = bucket.blob;
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const cmp = compareLineAt(blob, offsets, mid, target);
    if (cmp === 0) return true;
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }

  return false;
}

// Compares the host on line `i` against `target` by UTF-16 code unit, matching
// the order Array.prototype.sort produces in packHosts. Returns <0, 0, or >0.
// Compares in place to avoid allocating a substring per probe.
function compareLineAt(blob, offsets, i, target) {
  let p = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] - 1 : blob.length;
  let t = 0;
  while (p < end && t < target.length) {
    const a = blob.charCodeAt(p);
    const b = target.charCodeAt(t);
    if (a !== b) return a - b;
    p += 1;
    t += 1;
  }
  const lineRemaining = end - p;
  const targetRemaining = target.length - t;
  if (lineRemaining === 0 && targetRemaining === 0) return 0;
  return lineRemaining > 0 ? 1 : -1;
}
