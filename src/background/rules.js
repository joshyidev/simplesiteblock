import { extensionApi as ext } from "../extension_api.js";

// Atomically swap the full dynamic rule set: remove every existing rule and add
// the freshly packed ones in one update. No-ops where the DNR API is absent
// (e.g. node tests) so callers do not need to guard.
export async function applyDynamicRules(rules) {
  if (!ext.declarativeNetRequest) return;
  const existing = await ext.declarativeNetRequest.getDynamicRules();
  await ext.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: rules,
  });
}
