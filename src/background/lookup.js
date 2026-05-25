import { extensionApi as ext } from "../extension_api.js";
import { normalizeHostname } from "./parser/hosts.js";

// Answers "is this domain blocked, and why?" against the applied dynamic rules.
// Matching is subtree: a rule keyed on host H matches H and all subdomains, so
// the query matches a rule if any parent-suffix of the query is in the rule's
// requestDomains. Allow rules (priority 10) override block/redirect.
export async function lookupHost(input) {
  const host = normalizeHostname(extractHost(input));
  if (!host || !host.includes(".")) {
    return { ok: false, error: "Enter a valid domain." };
  }
  let rules;
  try {
    rules = await ext.declarativeNetRequest.getDynamicRules();
  } catch {
    return { ok: false, error: "Could not read the active rules." };
  }
  return { ok: true, host, ...evaluateLookup(host, rules) };
}

export function evaluateLookup(host, rules) {
  const suffixes = hostSuffixes(host);
  let allowMatch = null;
  let blockMatch = null;

  for (const rule of rules) {
    const domains = rule.condition?.requestDomains;
    if (!domains) continue;
    const matched = domains.find((domain) => suffixes.includes(domain));
    if (!matched) continue;

    const type = rule.action?.type;
    if (type === "allow") {
      allowMatch ??= matched;
    } else if (type === "redirect" || type === "block") {
      blockMatch ??= matched;
    }
  }

  if (allowMatch) return { verdict: "allowed", matchedHost: allowMatch };
  if (blockMatch) return { verdict: "blocked", matchedHost: blockMatch };
  return { verdict: "none", matchedHost: null };
}

// Accept a bare domain or a pasted URL: when the input carries a scheme or
// path, parse out the hostname before validation.
function extractHost(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed || !/[/:]/.test(trimmed)) return trimmed;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    return new URL(withScheme).hostname;
  } catch {
    return trimmed;
  }
}

// Parent-suffixes of a host, excluding the bare TLD:
// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com"]
function hostSuffixes(host) {
  const labels = host.split(".");
  const out = [];
  for (let i = 0; i < labels.length - 1; i += 1) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}
