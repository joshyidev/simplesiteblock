import { extensionApi as ext } from "../extension_api.js";
import { parseAdblock } from "./parser/adblock.js";
import { parseHosts } from "./parser/hosts.js";
import {
  getRawList,
  getState,
  removeRawList,
  saveCustomRules,
  saveLists,
  savePendingRebuild,
  saveRawList,
} from "./storage.js";

export const ALARM_NAME = "update:index";
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 25 * 1024 * 1024;
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
  await savePendingRebuild(true);
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
  await savePendingRebuild(true);
}

export async function updateListIdentity(listId, { name, url }) {
  const state = await getState({ includeRawLists: false });
  const target = state.lists.find((list) => list.id === listId);
  if (!target) throw new Error("List not found");

  const normalizedUrl = normalizeListUrl(url);
  if (
    state.lists.some(
      (list) =>
        list.id !== listId && normalizeStoredListUrl(list.url) === normalizedUrl,
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
  await savePendingRebuild(true);
  return lists;
}

export async function updateListSettings(listId, patch) {
  const state = await getState({ includeRawLists: false });
  const lists = state.lists.map((list) =>
    list.id === listId ? { ...list, ...patch } : list,
  );
  await saveLists(lists);
  if ("enabled" in patch || "format" in patch) await savePendingRebuild(true);
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
  // Raw bodies changed but no rules are applied yet (the DNR pipeline lands
  // later); flag that a rebuild is owed.
  await savePendingRebuild(true);
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
  parseCustomRules(customRules);
  await saveCustomRules(customRules);
  await savePendingRebuild(true);
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
