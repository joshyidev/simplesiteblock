import { normalizeHostname } from "./parser/hosts.js";

// Validate hosts as written (no eTLD+1 reduction) and drop any host whose parent
// is already present: subtree matching on the parent already covers it. See
// DNR.md "Matching model" and "Normalization".
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function normalizeHosts(rawHosts) {
  const valid = new Set();
  for (const raw of rawHosts) {
    const host = normalizeHostname(raw);
    // normalizeHostname accepts all-numeric labels, so reject IPv4 literals
    // explicitly (IPv6 is already rejected upstream by its colons).
    if (host && host.includes(".") && !IPV4_RE.test(host)) valid.add(host);
  }
  return pruneCoveredSubdomains(valid);
}

function pruneCoveredSubdomains(hosts) {
  const kept = new Set();
  for (const host of hosts) {
    if (!hasListedAncestor(host, hosts)) kept.add(host);
  }
  return kept;
}

function hasListedAncestor(host, hosts) {
  const labels = host.split(".");
  // Walk parent suffixes, excluding the host itself and the bare TLD.
  for (let i = 1; i < labels.length - 1; i += 1) {
    if (hosts.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
