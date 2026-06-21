import { extensionApi as ext } from "../extension_api.js";
import { getGuardHosts } from "./storage.js";

const BLOCK_PAGE_PATH = "/src/blocked/blocked.html";

let matcherCache = { builtAt: null, matcher: null };

export function registerNavigationGuard() {
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
  const host = hostnameOf(url);
  if (!host) return false;
  const matcher = await getMatcher();
  return matcher.isBlocked(host);
}

function hostnameOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

async function getMatcher() {
  const { rulesBuiltAt } = await ext.storage.local.get({ rulesBuiltAt: 0 });
  if (matcherCache.builtAt !== rulesBuiltAt) {
    const hosts = await getGuardHosts();
    matcherCache = { builtAt: rulesBuiltAt, matcher: buildMatcher(hosts) };
  }
  return matcherCache.matcher;
}

export function buildMatcher({ list, custom }) {
  const customAllow = new Set(custom.allow);
  const customBlock = new Set(custom.block);
  const listAllow = new Set(list.allow);
  const listBlock = new Set(list.block);
  return {
    isBlocked(host) {
      if (matchesSubtree(host, customAllow)) return false;
      if (matchesSubtree(host, customBlock)) return true;
      if (matchesSubtree(host, listAllow)) return false;
      if (matchesSubtree(host, listBlock)) return true;
      return false;
    },
  };
}

function matchesSubtree(host, set) {
  if (set.size === 0) return false;
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
