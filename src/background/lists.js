import {
  createIndexAccumulator,
  mergeParsedIntoIndex,
  serializeIndex,
} from "./engine.js";
import { extensionApi as ext } from "../extension_api.js";
import { parseAdblock } from "./parser/adblock.js";
import { parseHosts } from "./parser/hosts.js";
import {
  getRawList,
  getState,
  removeRawList,
  saveCompiledIndex,
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
let compilePromise = null;

export async function addList({ name, url }) {
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
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
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
  await saveLists(state.lists.filter((list) => list.id !== listId));
  await removeRawList(listId);
  await savePendingRebuild(true);
}

export async function updateListIdentity(listId, { name, url }) {
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
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
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
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
  await compileAndStoreIndex();
}

async function fetchAndStoreEnabledLists() {
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
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
        if (!result.notModified) await saveRawList(list.id, result.text);
        fetchResults.set(list.id, {
          ok: true,
          result: {
            etag: result.etag,
            lastModified: result.lastModified,
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
    };
  });

  await saveLists(lists);
}

export async function updateCustomRules(rawRules) {
  const customRules = String(rawRules || "");
  parseCustomRules(customRules);
  await saveCustomRules(customRules);
  return compileAndStoreIndex();
}

export async function updateListNow(listId, { compile = true } = {}) {
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
  const target = state.lists.find((list) => list.id === listId);
  if (!target) throw new Error("List not found");

  try {
    const cachedText = await getRawList(listId);
    const result = await fetchList(target, {
      hasCachedBody: cachedText !== null,
    });
    if (result.notModified && cachedText === null) {
      throw new Error(
        "The server returned not modified, but no cached list body is available.",
      );
    }
    const text = result.notModified ? cachedText : result.text;
    const parsed = parseListText(text, target.format);
    const lists = state.lists.map((list) =>
      list.id === listId
        ? {
            ...list,
            ruleCount: countRules(parsed),
            lastError: null,
            etag: result.etag ?? list.etag,
            lastModified: result.lastModified ?? list.lastModified,
          }
        : list,
    );

    if (!result.notModified) await saveRawList(listId, result.text);

    await saveLists(lists);
    if (compile) {
      await compileAndStoreIndex();
    } else {
      await savePendingRebuild(true);
    }
  } catch (error) {
    const lists = state.lists.map((list) =>
      list.id === listId ? { ...list, lastError: error.message } : list,
    );
    await saveLists(lists);
    throw error;
  }
}

export async function compileAndStoreIndex() {
  if (compilePromise) return compilePromise;
  compilePromise = doCompileAndStoreIndex();
  try {
    return await compilePromise;
  } finally {
    compilePromise = null;
  }
}

async function doCompileAndStoreIndex() {
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
  const index = createIndexAccumulator();
  if (state.customRules.trim()) {
    mergeParsedIntoIndex(index, parseCustomRules(state.customRules));
  }

  const lists = [];
  for (const list of state.lists) {
    const text = list.enabled ? await getRawList(list.id) : null;
    if (!list.enabled || text === null) {
      lists.push(list);
      continue;
    }
    try {
      const parsed = parseListText(text, list.format);
      mergeParsedIntoIndex(index, parsed);
      lists.push({
        ...list,
        ruleCount: countRules(parsed),
        lastError: null,
      });
    } catch (error) {
      lists.push({ ...list, ruleCount: 0, lastError: error.message });
    }
  }

  const compiledIndex = serializeIndex(index);
  await saveCompiledIndex(compiledIndex);
  await saveLists(lists);
  return compiledIndex;
}

export async function reconcileAlarms() {
  if (!ext.alarms) return;
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
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
      hostBlocksExact: new Set(),
      hostAllowsExact: new Set(),
      hostBlocksSubtree: new Set(),
      hostAllowsSubtree: new Set(),
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
    hostBlocksExact: parsed.hosts,
    hostAllowsExact: new Set(),
    hostBlocksSubtree: new Set(),
    hostAllowsSubtree: new Set(),
    warnings: parsed.warnings,
    mappingLineCount: parsed.mappingLineCount || 0,
    detectedFormat,
  };
}

function countRules(parsed) {
  return (
    (parsed.hostBlocksExact?.size || 0) +
    (parsed.hostAllowsExact?.size || 0) +
    (parsed.hostBlocksSubtree?.size || 0) +
    (parsed.hostAllowsSubtree?.size || 0)
  );
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
