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
  saveAppliedCustomSlice,
  saveAppliedListSlice,
  saveCustomRules,
  saveLastListUpdateAttemptAt,
  saveLastListUpdateCompletedAt,
  saveSliceBuildError,
  saveLists,
  saveListsWithRawList,
  saveRawList,
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
const FALLBACK_MAX_UNSAFE_DYNAMIC_RULES = 5000;
// Headroom for the custom slice's redirects. Custom rules cap at 1,000 domains,
// which packs into a single redirect rule, so this is generous.
const CUSTOM_REDIRECT_RESERVE = 10;

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
const MINUTE_MS = 60 * 1000;
const ALARM_TIME_TOLERANCE_MS = MINUTE_MS;

let listOperationTail = Promise.resolve();
let updateAllPromise = null;

// List bodies and metadata live under separate storage keys, so serialize every
// workflow that can change either side of that relationship.
export function runListOperation(operation) {
  const result = listOperationTail.then(operation, operation);
  listOperationTail = result.catch(() => {});
  return result;
}

export function addList(input) {
  return runListOperation(() => doAddList(input));
}

async function doAddList({ name, url }) {
  const state = await getState({ includeRawLists: false });
  const normalizedUrl = normalizeListUrl(url);
  assertListUrlAvailable(state.lists, normalizedUrl);

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

  // Fetch the new subscription up front so it can start blocking immediately;
  // a list that fails to fetch is still added and contributes nothing until a
  // later Update All succeeds.
  let outcome;
  try {
    outcome = { ok: true, result: await fetchListResult(list) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const storedList = mergeListFetchOutcome(list, outcome);
  const latest = await getState({ includeRawLists: false });
  assertListUrlAvailable(latest.lists, normalizedUrl);
  await saveListsWithRawList([...latest.lists, storedList], {
    listId: list.id,
    text: outcome.ok ? outcome.result.downloadedText : null,
  });
  await applyListRules();

  const error = fetchOutcomeError(outcome);
  if (error) {
    return {
      listId: list.id,
      ruleCount: null,
      error,
    };
  }
  return {
    listId: list.id,
    ruleCount: outcome.result.ruleCount,
    error: null,
  };
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

function assertListUrlAvailable(lists, normalizedUrl) {
  if (
    lists.some((list) => normalizeStoredListUrl(list.url) === normalizedUrl)
  ) {
    throw new Error("This list has already been added.");
  }
}

export function removeList(listId) {
  return runListOperation(() => doRemoveList(listId));
}

async function doRemoveList(listId) {
  const state = await getState({ includeRawLists: false });
  await saveLists(state.lists.filter((list) => list.id !== listId));
  await removeRawList(listId);
  await applyListRules();
}

export function updateListIdentity(listId, identity) {
  return runListOperation(() => doUpdateListIdentity(listId, identity));
}

async function doUpdateListIdentity(listId, { name, url }) {
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
  await applyListRules();
  return lists;
}

export function updateListSettings(listId, patch) {
  return runListOperation(() => doUpdateListSettings(listId, patch));
}

async function doUpdateListSettings(listId, patch) {
  const state = await getState({ includeRawLists: false });
  const lists = state.lists.map((list) =>
    list.id === listId ? { ...list, ...patch } : list,
  );
  await saveLists(lists);
  await applyListRules();
}

export async function updateAllLists() {
  if (updateAllPromise) return updateAllPromise;
  updateAllPromise = runListOperation(doUpdateAllLists);
  try {
    return await updateAllPromise;
  } finally {
    updateAllPromise = null;
  }
}

async function doUpdateAllLists() {
  await saveLastListUpdateAttemptAt(Date.now());
  const summary = await fetchAndStoreEnabledLists();
  await saveLastListUpdateCompletedAt(Date.now());
  // Rebuild both slices: this reapplies lists after the fetch and keeps the
  // custom slice consistent (also self-heals rules left by older builds).
  await rebuildAll();
  return summary;
}

// Records why one slice's build failed, against that slice's own key. Update All
// runs from the alarm and reconciliation runs at startup, both with no UI
// attached and their errors swallowed — without this a failed build (e.g. over
// the redirect budget) leaves stale rules applied with nothing to explain it.
// Rethrows so callers that do have a UI still surface the error directly.
// Per-slice keys matter because reconciliation often rebuilds only one slice: a
// successful custom build must not clear a standing list-build failure, which is
// the options page's only signal that the current list data was never applied.
async function withRuleBuildErrorRecorded(slice, rebuild) {
  try {
    await rebuild();
  } catch (error) {
    await saveSliceBuildError(slice, error?.message || "Applying rules failed.");
    throw error;
  }
  await saveSliceBuildError(slice, null);
}

// Apply both rule slices. Used by Update All and by settings import, where lists
// and custom rules both change at once. A list-slice failure aborts before the
// custom slice, so its rules stay as last applied rather than being rebuilt
// against a configuration that just failed to apply.
export async function rebuildAll() {
  await withRuleBuildErrorRecorded("list", rebuildListRules);
  await withRuleBuildErrorRecorded("custom", rebuildCustomRules);
}

// Rebuild and apply the list rule slice from cached list bodies. Every list edit
// runs this, so what is applied always matches the current configuration; a list
// with no cached body yet simply contributes nothing until a fetch gives it one.
// Custom rules are a separate slice and are untouched here.
export async function rebuildListRules() {
  const state = await getState({ includeRawLists: false });
  const block = new Set();
  const allow = new Set();

  for (const list of state.lists) {
    if (!list.enabled) continue;
    const text = await getRawList(list.id);
    if (text === null) continue;
    try {
      addParsedHosts(parseListText(text, list.format), block, allow);
    } catch {
      // Bodies are validated before caching, so this only catches junk cached by
      // an older build. The list's lastError is tracked at fetch time.
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
  await saveAppliedListSlice({
    block: blockHosts,
    allow: allowHosts,
    ruleCount: rules.length,
    guardCacheVersion: nextGuardCacheVersion(),
  });
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
  await saveAppliedCustomSlice({
    block: blockHosts,
    allow: allowHosts,
    ruleCount: rules.length,
    guardCacheVersion: nextGuardCacheVersion(),
  });
}

// The navigation guard's cache key: a fresh token per commit, never derived from
// the stored value or the clock. `incognito: "split"` gives the regular and
// incognito workers separate in-memory operation queues over one shared storage,
// so a read-modify-write counter can hand two concurrent commits the same value,
// and back-to-back slice commits can share a millisecond. Either way the guard
// would keep a matcher it believes is current while a slice's hosts are missing
// from it. Only inequality is ever tested, so uniqueness is the whole contract.
function nextGuardCacheVersion() {
  return crypto.randomUUID();
}

function addParsedHosts(parsed, block, allow) {
  for (const host of parsed.block) block.add(host);
  for (const host of parsed.allow) allow.add(host);
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
  const needsCustomRebuild = customOrphaned || customMissing;

  // The applied rule count answers both questions. Zero with rules present means
  // rules outlived the storage that made them (an unpacked reload or a reset);
  // non-zero with the slice empty means they vanished. Rules never diverge from
  // the configuration otherwise, because every list edit reapplies the slice.
  const orphanedListRules = state.appliedListRuleCount === 0 && hasListRules;
  const listRulesMissing = state.appliedListRuleCount > 0 && !hasListRules;
  const needsListRebuild = orphanedListRules || listRulesMissing;

  // Each slice records against its own key, so rebuilding one here leaves any
  // standing error on the other — and the slice it did not touch — untouched.
  if (needsCustomRebuild) {
    await withRuleBuildErrorRecorded("custom", rebuildCustomRules);
  }
  if (needsListRebuild) {
    await withRuleBuildErrorRecorded("list", rebuildListRules);
  }
}

// Reapply the list slice after a list edit. Adding, removing, enabling,
// disabling, or repointing a list takes effect immediately rather than waiting
// for the next Update All, so a disabled or removed list stops blocking at once.
// Records against the list slice's error key like every other list build.
function applyListRules() {
  return withRuleBuildErrorRecorded("list", rebuildListRules);
}

async function fetchAndStoreEnabledLists() {
  const state = await getState({ includeRawLists: false });
  const enabledLists = state.lists.filter((list) => list.enabled);
  const fetchResults = new Map();

  await Promise.allSettled(
    enabledLists.map(async (list) => {
      try {
        const result = await fetchListResult(list);
        fetchResults.set(list.id, {
          ok: true,
          result,
        });
      } catch (error) {
        fetchResults.set(list.id, { ok: false, error });
      }
    }),
  );

  const fetchedLists = new Map(enabledLists.map((list) => [list.id, list]));
  const latest = await getState({ includeRawLists: false });
  const rawWrites = [];
  // Counted from the outcomes actually merged, so a list edited or removed
  // mid-fetch (dropped by sameListSource) is not reported as checked.
  const summary = { checked: 0, updated: 0, unchanged: 0, failed: 0 };
  const lists = latest.lists.map((list) => {
    const fetchedList = fetchedLists.get(list.id);
    const outcome = fetchResults.get(list.id);
    if (!outcome || !sameListSource(list, fetchedList)) return list;
    summary.checked += 1;
    if (!outcome.ok) {
      summary.failed += 1;
    } else if (outcome.result.downloadedText !== null) {
      summary.updated += 1;
      rawWrites.push(saveRawList(list.id, outcome.result.downloadedText));
    } else {
      summary.unchanged += 1;
    }
    return mergeListFetchOutcome(list, outcome);
  });

  await Promise.all(rawWrites);
  await saveLists(lists);
  return summary;
}

function sameListSource(current, fetched) {
  return (
    fetched &&
    current.url === fetched.url &&
    current.format === fetched.format &&
    current.enabled === fetched.enabled
  );
}

// Resolves only for a download that parsed cleanly. A body that fails to parse
// rejects like a network failure so the caller keeps the last known-good cached
// body instead of overwriting it with junk (a list URL that starts serving an
// error page would otherwise silently stop blocking on the next auto-update).
async function fetchListResult(list) {
  const cachedText = await getRawList(list.id);
  const result = await fetchList(list, {
    hasCachedBody: cachedText !== null,
  });
  if (result.notModified && cachedText === null) {
    throw new Error("Server returned not modified but no cached body.");
  }

  const text = result.notModified ? cachedText : result.text;
  const ruleCount = countRules(parseListText(text, list.format));

  return {
    downloadedText: result.notModified ? null : result.text,
    etag: result.etag,
    lastModified: result.lastModified,
    ruleCount,
  };
}

// A failed fetch or rejected body keeps the list's cached validators and rule
// count: they still describe the body that stays cached and applied.
function mergeListFetchOutcome(list, outcome) {
  if (!outcome.ok) {
    return {
      ...list,
      lastError: outcome.error?.message || "List update failed.",
    };
  }
  const { result } = outcome;
  return {
    ...list,
    lastError: null,
    etag: result.etag ?? list.etag,
    lastModified: result.lastModified ?? list.lastModified,
    ruleCount: result.ruleCount,
  };
}

function fetchOutcomeError(outcome) {
  if (outcome.ok) return null;
  return outcome.error?.message || "List update failed.";
}

export function updateCustomRules(rawRules) {
  return runListOperation(() => doUpdateCustomRules(rawRules));
}

async function doUpdateCustomRules(rawRules) {
  const customRules = String(rawRules || "");
  assertCustomRulesWithinLimit(parseCustomRules(customRules));
  await saveCustomRules(customRules);
  await withRuleBuildErrorRecorded("custom", rebuildCustomRules);
}

// The cap on unsafe (redirect) dynamic rules, read from the runtime so a browser
// that raises or lowers it is respected. Only `redirect` is unsafe in DNR;
// `allow` rules are safe and do not count against this.
function maxListRedirectRules() {
  const cap =
    ext.declarativeNetRequest?.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ??
    FALLBACK_MAX_UNSAFE_DYNAMIC_RULES;
  return cap - CUSTOM_REDIRECT_RESERVE;
}

// Guards against exceeding DNR's unsafe (redirect) rule cap. Throws a
// user-facing message rather than letting updateDynamicRules fail cryptically.
export function assertListRedirectBudget(redirectRuleCount) {
  if (redirectRuleCount > maxListRedirectRules()) {
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

  const now = Date.now();
  const periodMs = periodInMinutes * MINUTE_MS;
  const dueAt = state.lastListUpdateAttemptAt
    ? state.lastListUpdateAttemptAt + periodMs
    : now;
  const overdue = dueAt <= now;
  // An unset attempt time intentionally schedules a prompt first update after
  // install/upgrade. Use Chrome's released-extension minimum delay explicitly.
  const when = overdue ? now + MINUTE_MS : dueAt;
  const periodMatches = existing?.periodInMinutes === periodInMinutes;
  const hasScheduledTime = Number.isFinite(existing?.scheduledTime);
  const scheduleMatches =
    periodMatches &&
    hasScheduledTime &&
    (overdue
      ? existing.scheduledTime <= when + ALARM_TIME_TOLERANCE_MS
      : Math.abs(existing.scheduledTime - when) <=
        ALARM_TIME_TOLERANCE_MS);

  if (scheduleMatches) return;
  if (existing) await ext.alarms.clear(ALARM_NAME);
  await ext.alarms.create(ALARM_NAME, {
    when,
    periodInMinutes,
  });
}

export async function handleAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  const firedAt = Date.now();
  try {
    await updateAllLists();
  } catch {
    // Errors are stored per-list; keep the worker quiet.
  } finally {
    await recordAlarmAttempt(firedAt);
  }
}

// The cadence is anchored to lastListUpdateAttemptAt, which doUpdateAllLists
// records before fetching. If the update failed before getting that far,
// reconcileAlarms would keep seeing an overdue schedule and re-arm at the
// minimum delay on every worker wake, refetching every minute. Recording the
// fire time here makes a failed run cost one period, like a failed fetch does.
async function recordAlarmAttempt(firedAt) {
  try {
    const state = await getState({ includeRawLists: false });
    if (state.lastListUpdateAttemptAt >= firedAt) return;
    await saveLastListUpdateAttemptAt(firedAt);
  } catch {
    // Storage is unavailable; the next alarm tries again.
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
