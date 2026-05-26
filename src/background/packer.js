// Packs normalized hosts into declarativeNetRequest dynamic rules. requestDomains
// matches a host and all its subdomains, so every rule is subtree by nature.
const PACK_SIZE = 1000;
const BLOCK_PAGE_PATH = "/src/blocked/blocked.html";
const SAFE_RESOURCE_TYPES = [
  "sub_frame",
  "script",
  "image",
  "media",
  "xmlhttprequest",
  "stylesheet",
  "font",
  "object",
  "ping",
  "other",
];

// idBase namespaces the rule IDs so independently-applied sets (lists vs custom
// rules) never collide. The priority band lets one set outrank another; within a
// band, allow > redirect/block by priority. Allow always wins via the highest.
export function packRules(blockHosts, allowHosts, options = {}) {
  const {
    idBase = 1,
    allowPriority = 10,
    redirectPriority = 2,
    blockPriority = 1,
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
        resourceTypes: ["main_frame", ...SAFE_RESOURCE_TYPES],
      },
    });
  }

  // Top-level navigations redirect to the block page; subresources are blocked.
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
    rules.push({
      id: id++,
      priority: blockPriority,
      action: { type: "block" },
      condition: { requestDomains: batch, resourceTypes: SAFE_RESOURCE_TYPES },
    });
  }

  return rules;
}
