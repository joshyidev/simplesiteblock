// Packs normalized hosts into declarativeNetRequest dynamic rules. requestDomains
// matches a host and all its subdomains, so every rule is subtree by nature.
const PACK_SIZE = 1000;
const BLOCK_PAGE_PATH = "/src/blocked/blocked.html";

// idBase namespaces the rule IDs so independently-applied sets (lists vs custom
// rules) never collide. The priority band lets one set outrank another; the
// allow band sits above redirect so an allow always wins. Blocking is top-level
// only: a redirect to the block page on main_frame (no subresource rules).
export function packRules(blockHosts, allowHosts, options = {}) {
  const {
    idBase = 1,
    allowPriority = 10,
    redirectPriority = 2,
  } = options;

  const block = [...blockHosts].sort();
  const allow = [...allowHosts].sort();
  const rules = [];
  let id = idBase;

  for (let i = 0; i < allow.length; i += PACK_SIZE) {
    rules.push({
      id: id++,
      priority: allowPriority,
      action: { type: "allow" },
      condition: {
        requestDomains: allow.slice(i, i + PACK_SIZE),
        resourceTypes: ["main_frame"],
      },
    });
  }

  // Top-level navigations redirect to the block page.
  for (let i = 0; i < block.length; i += PACK_SIZE) {
    const batch = block.slice(i, i + PACK_SIZE);
    rules.push({
      id: id++,
      priority: redirectPriority,
      action: {
        type: "redirect",
        redirect: { extensionPath: BLOCK_PAGE_PATH },
      },
      condition: { requestDomains: batch, resourceTypes: ["main_frame"] },
    });
  }

  return rules;
}
