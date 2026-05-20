const BLOCK_IPS = new Set(["0.0.0.0", "127.0.0.1", "::", "::1"]);
const SKIPPED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "broadcasthost",
  "local",
]);

export function parseHosts(rawText) {
  const hosts = new Set();
  const warnings = [];
  let mappingLineCount = 0;

  for (const [lineIndex, rawLine] of rawText.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    if (!BLOCK_IPS.has(tokens[0]) || tokens.length < 2) continue;

    mappingLineCount += 1;
    const candidates = tokens.slice(1);

    for (const candidate of candidates) {
      const normalized = normalizeHostname(candidate);
      if (!normalized) {
        warnings.push(
          `Line ${lineIndex + 1}: skipped invalid host "${candidate}"`,
        );
        continue;
      }
      if (!SKIPPED_HOSTS.has(normalized)) hosts.add(normalized);
    }
  }

  return { hosts, warnings, mappingLineCount };
}

export function normalizeHostname(value) {
  if (!value || typeof value !== "string") return null;

  let input = value.trim().toLowerCase();
  if (!input || input.includes("/") || input.includes(":")) return null;
  input = input.replace(/\.$/, "");
  // SKIPPED_HOSTS are known-safe strings; callers filter them out before use.
  if (!input || SKIPPED_HOSTS.has(input)) return input;

  let ascii;
  try {
    ascii = new URL(`http://${input}/`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return null;
  }

  if (!isValidDnsHostname(ascii)) return null;
  return ascii;
}

function isValidDnsHostname(hostname) {
  if (!hostname || hostname.length > 253) return false;
  const labels = hostname.split(".");
  if (labels.length === 0) return false;

  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}
