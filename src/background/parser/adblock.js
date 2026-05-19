import { normalizeHostname } from "./hosts.js";

const MAX_REGEX_SOURCE_LENGTH = 2000;
const UNSUPPORTED_OPTION_RE =
  /\$(?:csp|rewrite|removeparam|redirect|replace|permissions)=/i;

export function parseAdblock(rawText) {
  const output = {
    hostBlocksExact: new Set(),
    hostAllowsExact: new Set(),
    hostBlocksSubtree: new Set(),
    hostAllowsSubtree: new Set(),
    regexBlocks: [],
    regexAllows: [],
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
    const targetRegexes = isAllow ? output.regexAllows : output.regexBlocks;

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

    const regex = pattern.startsWith("/")
      ? parseRegexRule(pattern)
      : compilePatternRule(pattern);
    if (!regex) {
      output.warnings.push(`Line ${lineNumber}: skipped invalid rule`);
      continue;
    }
    targetRegexes.push(regex);
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

function parseRegexRule(pattern) {
  if (!pattern.startsWith("/") || pattern.length < 2) return null;
  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash <= 0) return null;

  const source = pattern.slice(1, lastSlash);
  const flags = normalizeFlags(pattern.slice(lastSlash + 1));
  return makeRegexRecord(source, flags);
}

function compilePatternRule(pattern) {
  if (!pattern || pattern === "*" || pattern.length > MAX_REGEX_SOURCE_LENGTH)
    return null;
  if (!/[./*^|]/.test(pattern)) return null;

  let source = "";
  let working = pattern;

  if (working.startsWith("|")) {
    source += "^";
    working = working.slice(1);
  }

  let endsWithAnchor = false;
  if (working.endsWith("|")) {
    endsWithAnchor = true;
    working = working.slice(0, -1);
  }

  for (const char of working) {
    if (char === "*") {
      source += ".*";
    } else if (char === "^") {
      source += "(?:[^A-Za-z0-9_.%-]|$)";
    } else {
      source += escapeRegex(char);
    }
  }

  if (endsWithAnchor) source += "$";
  return makeRegexRecord(source, "i");
}

function normalizeFlags(flags) {
  const unique = new Set((flags || "").replace(/[^dgimsuvy]/g, "").split(""));
  unique.add("i");
  return [...unique].join("");
}

function makeRegexRecord(source, flags) {
  if (!source || source.length > MAX_REGEX_SOURCE_LENGTH) return null;
  try {
    new RegExp(source, flags);
  } catch {
    return null;
  }
  return { source, flags };
}

function escapeRegex(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
