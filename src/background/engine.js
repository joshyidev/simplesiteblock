export const EMPTY_SERIALIZED_INDEX = Object.freeze({
  hostBlocks: [],
  hostAllows: [],
  regexBlocks: [],
  regexAllows: [],
  builtAt: 0,
});

export function hydrateIndex(serialized = EMPTY_SERIALIZED_INDEX) {
  return {
    hostBlocks: new Set(serialized.hostBlocks || []),
    hostAllows: new Set(serialized.hostAllows || []),
    regexBlocks: hydrateRegexes(serialized.regexBlocks || []),
    regexAllows: hydrateRegexes(serialized.regexAllows || []),
    builtAt: serialized.builtAt || 0,
  };
}

export function serializeIndex(index) {
  return {
    hostBlocks: [...(index.hostBlocks || [])].sort(),
    hostAllows: [...(index.hostAllows || [])].sort(),
    regexBlocks: [...(index.regexBlocks || [])].map(serializeRegex),
    regexAllows: [...(index.regexAllows || [])].map(serializeRegex),
    builtAt: index.builtAt || Date.now(),
  };
}

export function createCombinedIndex(parsedLists) {
  const combined = {
    hostBlocks: new Set(),
    hostAllows: new Set(),
    regexBlocks: [],
    regexAllows: [],
    builtAt: Date.now(),
  };

  for (const parsed of parsedLists) {
    for (const host of parsed.hostBlocks || parsed.hosts || [])
      combined.hostBlocks.add(host);
    for (const host of parsed.hostAllows || []) combined.hostAllows.add(host);
    combined.regexBlocks.push(...(parsed.regexBlocks || []));
    combined.regexAllows.push(...(parsed.regexAllows || []));
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
  if (matchesHost(index.hostAllows, host)) return { blocked: false };
  for (const rule of index.regexAllows || []) {
    if (testRule(rule, url)) return { blocked: false };
  }

  if (matchesHost(index.hostBlocks, host)) {
    return { blocked: true, reason: `host:${host}` };
  }

  for (const rule of index.regexBlocks || []) {
    if (testRule(rule, url))
      return { blocked: true, reason: `regex:${rule.source}` };
  }

  return { blocked: false };
}

export function matchesHost(hostSet, host) {
  if (!hostSet || !host) return false;
  const labels = host.toLowerCase().split(".");
  for (let index = 0; index < labels.length; index += 1) {
    if (hostSet.has(labels.slice(index).join("."))) return true;
  }
  return false;
}

function hydrateRegexes(records) {
  const regexes = [];
  for (const record of records) {
    try {
      regexes.push(new RegExp(record.source, record.flags || "i"));
    } catch {
      // Bad persisted data should not break every navigation.
    }
  }
  return regexes;
}

function serializeRegex(rule) {
  return rule instanceof RegExp
    ? { source: rule.source, flags: rule.flags }
    : { source: rule.source, flags: rule.flags || "i" };
}

function testRule(rule, url) {
  rule.lastIndex = 0;
  return rule.test(url);
}
