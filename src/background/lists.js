import { extensionApi as ext } from "../extension_api.js";
import { parseAdblock } from "./parser/adblock.js";
import { parseHosts } from "./parser/hosts.js";
import { normalizeHosts } from "./normalize.js";
import { packRules } from "./packer.js";
import { applyRuleSlice } from "./rules.js";
import {
  getRawList,
  getState,
  removeRawList,
  saveAppliedSignature,
  saveCustomDomainCount,
  saveCustomRuleCount,
  saveCustomRules,
  saveGuardHosts,
  saveListDomainCount,
  saveListRuleCount,
  saveLists,
  savePendingRebuild,
  saveRawList,
  saveRulesBuiltAt,
} from "./storage.js";

export const ALARM_NAME = "update:index";
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 25 * 1024 * 1024;
// The custom-rules box is for a handful of personal additions; bulk lists belong
// in a subscription. This keeps it scoped and reserves rule budget for lists.
const MAX_CUSTOM_DOMAINS = 1000;
// Top-level blocks are `redirect` rules, which are "unsafe" in DNR and capped at
// 5,000 across all dynamic rules. The packer emits one redirect rule per ~1,000
// main-frame block domains, so this bounds blockable domains at ~5 million. We
// reserve a little headroom for the (domain-capped) custom slice's redirects.
const MAX_UNSAFE_DYNAMIC_RULES = 5000;
const MAX_LIST_REDIRECT_RULES = MAX_UNSAFE_DYNAMIC_RULES - 10;

// Lists and custom rules occupy disjoint dynamic-rule ID ranges so each can be
// applied independently. Custom rules use a higher priority band so they win
// over subscribed lists (e.g. a custom block overrides a list's allow).
const LIST_RULE_ID_BASE = 1;
const CUSTOM_RULE_ID_BASE = 1_000_000;
const CUSTOM_PRIORITIES = {
  idBase: CUSTOM_RULE_ID_BASE,
  allowPriority: 30,
  redirectPriority: 22,
};
const FETCH_TIMEOUT_MS = 30000;

let updateAllPromise = null;

export async function addList({ name, url }) {
  const state = await getState({ includeRawLists: false });
  const normalizedUrl = normalizeListUrl(url);
  if (
    state.lists.some(
      (list) => normalizeStoredListUrl(list.url) === normalizedUrl,
    )
  ) {
    throw new Error("This list has already been added.");
  }

  const list = {
    id: crypto.randomUUID(),
    name: name?.trim() || new URL(normalizedUrl).hostname,
    url: normalizedUrl,
    format: "auto",
    enabled: true,
    lastError: null,
    etag: null,
    lastModified: null,
    ruleCount: 0,
  };

  await saveLists([...state.lists, list]);
  await recomputePending();
}

export function normalizeListUrl(value) {
  try {
    return new URL(String(value || "").trim()).href;
  } catch {
    throw new Error("Enter a valid list URL.");
  }
}

function normalizeStoredListUrl(value) {
  try {
    return normalizeListUrl(value);
  } catch {
    return null;
  }
}

export async function removeList(listId) {
  const state = await getState({ includeRawLists: false });
  await saveLists(state.lists.filter((list) => list.id !== listId));
  await removeRawList(listId);
  await recomputePending();
}

export async function updateListIdentity(listId, { name, url }) {
  const state = await getState({ includeRawLists: false });
  const target = state.lists.find((list) => list.id === listId);
  if (!target) throw new Error("List not found");

  const normalizedUrl = normalizeListUrl(url);
  if (
    state.lists.some(
      (list) =>
        list.id !== listId &&
        normalizeStoredListUrl(list.url) === normalizedUrl,
    )
  ) {
    throw new Error("This list has already been added.");
  }

  const urlChanged = normalizeStoredListUrl(target.url) !== normalizedUrl;
  const lists = state.lists.map((list) =>
    list.id === listId
      ? {
          ...list,
          name: name?.trim() || new URL(normalizedUrl).hostname,
          url: normalizedUrl,
          lastError: urlChanged ? null : list.lastError,
          etag: urlChanged ? null : list.etag,
          lastModified: urlChanged ? null : list.lastModified,
          ruleCount: urlChanged ? 0 : list.ruleCount,
        }
      : list,
  );

  await saveLists(lists);
  if (!urlChanged) return lists;

  await removeRawList(listId);
  await recomputePending();
  return lists;
}

export async function updateListSettings(listId, patch) {
  const state = await getState({ includeRawLists: false });
  const lists = state.lists.map((list) =>
    list.id === listId ? { ...list, ...patch } : list,
  );
  await saveLists(lists);
  await recomputePending();
}

export async function updateAllLists() {
  if (updateAllPromise) return updateAllPromise;
  updateAllPromise = doUpdateAllLists();
  try {
    return await updateAllPromise;
  } finally {
    updateAllPromise = null;
  }
}

async function doUpdateAllLists() {
  await fetchAndStoreEnabledLists();
  // Rebuild both slices: this reapplies lists after the fetch and keeps the
  // custom slice consistent (also self-heals rules left by older builds).
  await rebuildAll();
}

// Apply both rule slices. Used on settings import, where lists and custom rules
// both change at once.
export async function rebuildAll() {
  await rebuildListRules();
  await rebuildCustomRules();
}

// Rebuild and apply the list rule slice from cached list bodies. Sets
// pendingRebuild when an enabled list has no cached body yet (it needs a fetch
// before it can contribute rules). Custom rules are a separate slice and are
// untouched here.
export async function rebuildListRules() {
  const state = await getState({ includeRawLists: false });
  const block = new Set();
  const allow = new Set();
  let pending = false;

  for (const list of state.lists) {
    if (!list.enabled) continue;
    const text = await getRawList(list.id);
    if (text === null) {
      pending = true;
      continue;
    }
    try {
      addParsedHosts(parseListText(text, list.format), block, allow);
    } catch {
      // Invalid cached body; the list's lastError is tracked at fetch time.
    }
  }

  const blockHosts = normalizeHosts(block);
  const allowHosts = normalizeHosts(allow);
  const rules = packRules(blockHosts, allowHosts, {
    idBase: LIST_RULE_ID_BASE,
  });
  // Fail closed before touching DNR if we'd blow the unsafe-rule cap, so the
  // user gets a clear message instead of a raw updateDynamicRules rejection and
  // their existing rules stay applied.
  assertListRedirectBudget(
    rules.filter((rule) => rule.action.type === "redirect").length,
  );
  await applyRuleSlice(LIST_RULE_ID_BASE, CUSTOM_RULE_ID_BASE, rules);
  await saveListDomainCount(blockHosts.size);
  await saveListRuleCount(rules.length);
  // Persist the host sets for the navigation guard before bumping rulesBuiltAt,
  // which is how the guard knows to reload them.
  await saveGuardHosts("list", { block: blockHosts, allow: allowHosts });
  await saveRulesBuiltAt(Date.now());
  await saveAppliedSignature(rebuildSignature(state));
  await savePendingRebuild(pending);
}

// Rebuild and apply only the custom rule slice (higher priority band). Cheap:
// it never reads or reparses list bodies, so editing custom rules is unaffected
// by how large the subscribed lists are.
export async function rebuildCustomRules() {
  const state = await getState({ includeRawLists: false });
  const block = new Set();
  const allow = new Set();
  if (state.customRules.trim()) {
    addParsedHosts(parseCustomRules(state.customRules), block, allow);
  }

  const blockHosts = normalizeHosts(block);
  const allowHosts = normalizeHosts(allow);
  const rules = packRules(blockHosts, allowHosts, CUSTOM_PRIORITIES);
  await applyRuleSlice(CUSTOM_RULE_ID_BASE, Number.MAX_SAFE_INTEGER, rules);
  await saveCustomDomainCount(blockHosts.size);
  await saveCustomRuleCount(rules.length);
  await saveGuardHosts("custom", { block: blockHosts, allow: allowHosts });
  await saveRulesBuiltAt(Date.now());
}

function addParsedHosts(parsed, block, allow) {
  for (const host of parsed.block) block.add(host);
  for (const host of parsed.allow) allow.add(host);
}

// Fingerprint of the inputs that determine the applied list rule slice: which
// lists are enabled, with their format. Custom rules are excluded — they live in
// their own slice and apply immediately, so they never make lists "pending".
function rebuildSignature(state) {
  return JSON.stringify(
    state.lists
      .filter((list) => list.enabled)
      .map((list) => `${list.id}|${list.format}`)
      .sort(),
  );
}

export async function reconcileRules() {
  if (!ext.declarativeNetRequest) return;
  const state = await getState({ includeRawLists: false });
  const existing = await ext.declarativeNetRequest.getDynamicRules();
  const hasListRules = existing.some(
    (rule) => rule.id >= LIST_RULE_ID_BASE && rule.id < CUSTOM_RULE_ID_BASE,
  );
  const hasCustomRules = existing.some(
    (rule) => rule.id >= CUSTOM_RULE_ID_BASE,
  );

  const customOrphaned = state.customRules.trim() === "" && hasCustomRules;
  const customMissing = state.appliedCustomRuleCount > 0 && !hasCustomRules;
  if (customOrphaned || customMissing) {
    await rebuildCustomRules();
  }

  const orphanedListRules = state.appliedSignature === "" && hasListRules;
  const listRulesMissing = state.appliedListRuleCount > 0 && !hasListRules;
  if (orphanedListRules || listRulesMissing) {
    await rebuildListRules();
  }
}

// Set pendingRebuild to reflect whether a rebuild would actually change the
// applied rules: the config diverged from what was last applied, or an enabled
// list still has no cached body to contribute. A net-zero edit (e.g. disable
// then re-enable a list) lands back on the applied signature and clears pending.
export async function recomputePending() {
  const state = await getState({ includeRawLists: false });
  let pending = rebuildSignature(state) !== state.appliedSignature;
  if (!pending) {
    for (const list of state.lists) {
      if (list.enabled && (await getRawList(list.id)) === null) {
        pending = true;
        break;
      }
    }
  }
  await savePendingRebuild(pending);
}

async function fetchAndStoreEnabledLists() {
  const state = await getState({ includeRawLists: false });
  const enabledLists = state.lists.filter((list) => list.enabled);
  const fetchResults = new Map();

  await Promise.allSettled(
    enabledLists.map(async (list) => {
      try {
        const cachedText = await getRawList(list.id);
        const result = await fetchList(list, {
          hasCachedBody: cachedText !== null,
        });
        if (result.notModified && cachedText === null) {
          throw new Error("Server returned not modified but no cached body.");
        }
        const text = result.notModified ? cachedText : result.text;
        if (!result.notModified) await saveRawList(list.id, result.text);
        fetchResults.set(list.id, {
          ok: true,
          result: {
            etag: result.etag,
            lastModified: result.lastModified,
            ruleCount: countParsedText(text, list.format),
          },
        });
      } catch (error) {
        fetchResults.set(list.id, { ok: false, error });
      }
    }),
  );

  const lists = state.lists.map((list) => {
    const outcome = fetchResults.get(list.id);
    if (!outcome) return list;
    if (!outcome.ok) return { ...list, lastError: outcome.error.message };
    const { result } = outcome;
    return {
      ...list,
      lastError: null,
      etag: result.etag ?? list.etag,
      lastModified: result.lastModified ?? list.lastModified,
      ruleCount: result.ruleCount ?? list.ruleCount,
    };
  });

  await saveLists(lists);
}

export async function updateCustomRules(rawRules) {
  const customRules = String(rawRules || "");
  assertCustomRulesWithinLimit(parseCustomRules(customRules));
  await saveCustomRules(customRules);
  await rebuildCustomRules();
}

// Guards against exceeding DNR's 5,000 unsafe (redirect) rule cap. Throws a
// user-facing message rather than letting updateDynamicRules fail cryptically.
export function assertListRedirectBudget(redirectRuleCount) {
  if (redirectRuleCount > MAX_LIST_REDIRECT_RULES) {
    throw new Error(
      "Your enabled lists block more domains than Chrome's rule limit allows (about 5 million). Disable or remove some lists, then run Update All again.",
    );
  }
}

// Caps the custom-rules box at a handful of personal domains (bulk belongs in a
// subscription). Throws so both the save and import paths reject over-limit input.
export function assertCustomRulesWithinLimit(parsed) {
  const domainCount = parsed.block.size + parsed.allow.size;
  if (domainCount > MAX_CUSTOM_DOMAINS) {
    throw new Error(
      `Custom rules are limited to ${MAX_CUSTOM_DOMAINS} domains; found ${domainCount.toLocaleString()}. Put large lists in a subscription instead.`,
    );
  }
}

function countParsedText(text, format) {
  try {
    return countRules(parseListText(text, format));
  } catch {
    return 0;
  }
}

export async function reconcileAlarms() {
  if (!ext.alarms) return;
  const state = await getState({ includeRawLists: false });
  const periodInMinutes =
    clampInterval(state.settings.updateIntervalDays) * 1440;
  const existing = await ext.alarms.get(ALARM_NAME);

  if (periodInMinutes <= 0) {
    if (existing) await ext.alarms.clear(ALARM_NAME);
    return;
  }

  if (existing?.periodInMinutes === periodInMinutes) return;
  if (existing) await ext.alarms.clear(ALARM_NAME);
  ext.alarms.create(ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
}

export async function handleAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  try {
    await updateAllLists();
  } catch {
    // Errors are stored per-list; keep the worker quiet.
  }
}

export function parseListText(text, format = "auto") {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error(
      "This URL does not contain a valid hosts or Adblock block list.",
    );
  }

  if (format === "hosts") {
    const parsed = parseHosts(text);
    if (parsed.hosts.size === 0)
      throw new Error("This URL does not contain a valid hosts block list.");
    return asHostsParsed(parsed, "hosts");
  }
  if (format === "adblock") {
    const parsed = { ...parseAdblock(text), detectedFormat: "adblock" };
    if (countRules(parsed) === 0)
      throw new Error("This URL does not contain a valid Adblock filter list.");
    return parsed;
  }

  if (looksLikeHtmlDocument(text)) {
    throw new Error(
      "This URL looks like a web page, not a hosts or Adblock block list.",
    );
  }

  const hostsParsed = parseHosts(text);
  const adblockParsed = parseAdblock(text);
  const parsed =
    hostsParsed.mappingLineCount > 0
      ? asHostsParsed(hostsParsed, "hosts")
      : { ...adblockParsed, detectedFormat: "adblock" };

  if (countRules(parsed) === 0) {
    throw new Error(
      "This URL does not contain a valid hosts or Adblock block list.",
    );
  }

  return parsed;
}

export function parseCustomRules(text) {
  if (!text.trim()) {
    return {
      block: new Set(),
      allow: new Set(),
      warnings: [],
      detectedFormat: "adblock",
    };
  }

  if (looksLikeHtmlDocument(text)) {
    throw new Error("Custom rules must use Adblock syntax, not HTML.");
  }

  const parsed = { ...parseAdblock(text), detectedFormat: "adblock" };
  if (countRules(parsed) === 0) {
    throw new Error("Custom rules do not contain any valid Adblock rules.");
  }
  return parsed;
}

function asHostsParsed(parsed, detectedFormat) {
  return {
    block: parsed.hosts,
    allow: new Set(),
    warnings: parsed.warnings,
    mappingLineCount: parsed.mappingLineCount || 0,
    detectedFormat,
  };
}

function countRules(parsed) {
  return (parsed.block?.size || 0) + (parsed.allow?.size || 0);
}

function looksLikeHtmlDocument(text) {
  const sample = text.slice(0, 4096).toLowerCase();
  return (
    /<!doctype\s+html/.test(sample) ||
    /<html[\s>]/.test(sample) ||
    (/<head[\s>]/.test(sample) && /<body[\s>]/.test(sample))
  );
}

async function fetchList(list, { hasCachedBody = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {};
    if (hasCachedBody && list.etag) headers["If-None-Match"] = list.etag;
    if (hasCachedBody && list.lastModified) {
      headers["If-Modified-Since"] = list.lastModified;
    }

    const response = await fetch(list.url, {
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 304) {
      return {
        notModified: true,
        etag: response.headers.get("ETag"),
        lastModified: response.headers.get("Last-Modified"),
      };
    }
    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);

    const contentType = response.headers.get("Content-Type") || "";
    if (/\btext\/html\b/i.test(contentType)) {
      throw new Error(
        "This URL returned a web page, not a hosts or Adblock block list.",
      );
    }

    const contentLength = Number(response.headers.get("Content-Length") || 0);
    if (contentLength > MAX_CONTENT_LENGTH_BYTES) {
      throw new Error("List is larger than the 10 MB download limit");
    }

    const text = await response.text();
    if (new Blob([text]).size > MAX_TEXT_BYTES) {
      throw new Error("List is larger than the 25 MB text limit");
    }

    return {
      notModified: false,
      text,
      etag: response.headers.get("ETag"),
      lastModified: response.headers.get("Last-Modified"),
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Fetch timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function clampInterval(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(7, Math.max(1, Math.round(days)));
}
