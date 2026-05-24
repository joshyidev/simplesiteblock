export const EMPTY_SERIALIZED_INDEX = Object.freeze({
  hostBlocksExact: [],
  hostAllowsExact: [],
  hostBlocksSubtree: [],
  hostAllowsSubtree: [],
  builtAt: 0,
});

export function hydrateIndex(serialized = EMPTY_SERIALIZED_INDEX) {
  return {
    hostBlocksExact: sortedHosts(serialized.hostBlocksExact),
    hostAllowsExact: sortedHosts(serialized.hostAllowsExact),
    hostBlocksSubtree: sortedHosts(serialized.hostBlocksSubtree),
    hostAllowsSubtree: sortedHosts(serialized.hostAllowsSubtree),
    builtAt: serialized.builtAt || 0,
  };
}

export function countIndexRules(index = EMPTY_SERIALIZED_INDEX) {
  return (
    (index.hostBlocksExact?.length || 0) +
    (index.hostAllowsExact?.length || 0) +
    (index.hostBlocksSubtree?.length || 0) +
    (index.hostAllowsSubtree?.length || 0)
  );
}

export function serializeIndex(index) {
  return {
    hostBlocksExact: [...(index.hostBlocksExact || [])].sort(),
    hostAllowsExact: [...(index.hostAllowsExact || [])].sort(),
    hostBlocksSubtree: [...(index.hostBlocksSubtree || [])].sort(),
    hostAllowsSubtree: [...(index.hostAllowsSubtree || [])].sort(),
    builtAt: index.builtAt || Date.now(),
  };
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

export function matchesHostExact(hostSet, host) {
  if (!hostSet || !host) return false;
  const normalized = host.toLowerCase();
  return hostSet instanceof Set
    ? hostSet.has(normalized)
    : binaryIncludes(hostSet, normalized);
}

export function matchesHostSubtree(hostSet, host) {
  if (!hostSet || !host) return false;
  const labels = host.toLowerCase().split(".");
  for (let index = 0; index < labels.length; index += 1) {
    if (matchesHostExact(hostSet, labels.slice(index).join("."))) return true;
  }
  return false;
}

function sortedHosts(hosts) {
  return Array.isArray(hosts) ? hosts : [...(hosts || [])].sort();
}

function binaryIncludes(values, target) {
  let low = 0;
  let high = values.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = values[mid];
    if (value === target) return true;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }

  return false;
}
