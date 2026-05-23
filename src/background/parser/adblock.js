import { normalizeHostname } from "./hosts.js";

const UNSUPPORTED_OPTION_RE =
  /\$(?:csp|rewrite|removeparam|redirect|replace|permissions)=/i;

export function parseAdblock(rawText) {
  const output = {
    hostBlocksExact: new Set(),
    hostAllowsExact: new Set(),
    hostBlocksSubtree: new Set(),
    hostAllowsSubtree: new Set(),
    warnings: [],
  };

  for (const [lineIndex, rawLine] of rawText.split(/\r?\n/).entries()) {
    const lineNumber = lineIndex + 1;
    let line = stripDomainListComment(rawLine.trim());
    if (!line || line.startsWith("!")) continue;

    if (/\s/.test(line)) {
      output.warnings.push(
        `Line ${lineNumber}: skipped unsupported whitespace rule`,
      );
      continue;
    }

    if (isCosmeticRule(line)) {
      output.warnings.push(`Line ${lineNumber}: skipped cosmetic rule`);
      continue;
    }

    if (UNSUPPORTED_OPTION_RE.test(line) || line.includes("#%#")) {
      output.warnings.push(`Line ${lineNumber}: skipped unsupported rule`);
      continue;
    }

    const isAllow = line.startsWith("@@");
    if (isAllow) line = line.slice(2);
    const targetHostsExact = isAllow
      ? output.hostAllowsExact
      : output.hostBlocksExact;
    const targetHostsSubtree = isAllow
      ? output.hostAllowsSubtree
      : output.hostBlocksSubtree;

    const pattern = stripOptions(line);
    const bareHost = parseBareDomainRule(pattern);
    if (bareHost) {
      targetHostsExact.add(bareHost);
      continue;
    }

    const host = parseHostnameRule(pattern);
    if (host) {
      targetHostsSubtree.add(host);
      continue;
    }

    output.warnings.push(`Line ${lineNumber}: skipped unsupported rule`);
  }

  return output;
}

function stripDomainListComment(line) {
  if (line.startsWith("#")) return "";
  return line.replace(/\s+#.*$/, "").trim();
}

function isCosmeticRule(line) {
  return line.includes("##") || line.includes("#@#") || line.includes("#?#");
}

function stripOptions(line) {
  const optionIndex = line.indexOf("$");
  return (optionIndex === -1 ? line : line.slice(0, optionIndex)).trim();
}

function parseBareDomainRule(pattern) {
  const host = normalizeHostname(pattern);
  return host?.includes(".") ? host : null;
}

function parseHostnameRule(pattern) {
  if (!pattern.startsWith("||")) return null;
  const rest = pattern.slice(2);
  const domain = rest.split(/[\^/?*$|]/, 1)[0];
  return normalizeHostname(domain);
}
