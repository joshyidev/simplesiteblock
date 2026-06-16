import { extensionApi as ext } from "../extension_api.js";

const BLOCK_PAGE_PATH = "/src/blocked/blocked.html";

// Maps dynamic-rule ids to "is a redirect (block) rule", rebuilt only when the
// rules change (keyed by rulesBuiltAt), not per navigation.
let redirectIdCache = { builtAt: null, ids: null };

// Registered synchronously at worker top level (a requirement for the event to
// wake a dormant MV3 worker). navigator.brave is present only in Brave, so Chrome
// never registers the listener and pays nothing.
export function registerNavigationGuard() {
  if (typeof navigator === "undefined" || !navigator.brave) return;
  if (!ext.webNavigation) return;
  ext.webNavigation.onBeforeNavigate.addListener((details) => {
    void guardNavigation(details);
  });
}

export async function guardNavigation(details) {
  if (details.frameId !== 0) return; // top-level frame only
  if (!/^https?:/i.test(details.url)) return; // ignore chrome-extension:, etc.
  if (!(await isBlocked(details.url))) return;
  try {
    await ext.tabs.update(details.tabId, {
      url: ext.runtime.getURL(BLOCK_PAGE_PATH),
    });
  } catch {
    // Tab closed or navigated away before we could redirect it.
  }
}

async function isBlocked(url) {
  let outcome;
  try {
    outcome = await ext.declarativeNetRequest.testMatchOutcome({
      url,
      type: "main_frame",
      method: "get",
    });
  } catch {
    return false; // testMatchOutcome unavailable: leave DNR to handle it.
  }
  const matched = outcome?.matchedRules || [];
  if (matched.length === 0) return false;
  // Block only when the effective matched rule redirects; an allow exception
  // (@@) also "matches" but must not trigger a redirect.
  const redirectIds = await getRedirectRuleIds();
  return matched.some((rule) => redirectIds.has(rule.ruleId));
}

async function getRedirectRuleIds() {
  const { rulesBuiltAt } = await ext.storage.local.get({ rulesBuiltAt: 0 });
  if (redirectIdCache.builtAt !== rulesBuiltAt) {
    const rules = await ext.declarativeNetRequest.getDynamicRules();
    redirectIdCache = {
      builtAt: rulesBuiltAt,
      ids: new Set(
        rules
          .filter((rule) => rule.action.type === "redirect")
          .map((rule) => rule.id),
      ),
    };
  }
  return redirectIdCache.ids;
}
