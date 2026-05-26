import { extensionApi as ext } from "../extension_api.js";

// Atomically replace one rule slice: remove whatever dynamic rules currently
// occupy this slice's ID range [idBase, idCeiling) and add the freshly packed
// rules in one update. Removing by actual range (rather than a tracked count)
// self-heals stale rules left by older builds. No-ops where the DNR API is
// absent (e.g. node tests).
export async function applyRuleSlice(idBase, idCeiling, rules) {
  if (!ext.declarativeNetRequest) return;
  const existing = await ext.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule.id >= idBase && rule.id < idCeiling)
    .map((rule) => rule.id);
  await ext.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules,
  });
}
