export const EMPTY_SERIALIZED_INDEX = Object.freeze({
  hostBlocksExact: [],
  hostAllowsExact: [],
  hostBlocksSubtree: [],
  hostAllowsSubtree: [],
  builtAt: 0,
});

export function hydrateIndex(serialized = EMPTY_SERIALIZED_INDEX) {
  return {
    hostBlocksExact: new Set(serialized.hostBlocksExact || []),
    hostAllowsExact: new Set(serialized.hostAllowsExact || []),
    hostBlocksSubtree: new Set(serialized.hostBlocksSubtree || []),
    hostAllowsSubtree: new Set(serialized.hostAllowsSubtree || []),
    builtAt: serialized.builtAt || 0,
  };
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
  return !!hostSet?.has(host.toLowerCase());
}

export function matchesHostSubtree(hostSet, host) {
  if (!hostSet || !host) return false;
  const labels = host.toLowerCase().split(".");
  for (let index = 0; index < labels.length; index += 1) {
    if (hostSet.has(labels.slice(index).join("."))) return true;
  }
  return false;
}
