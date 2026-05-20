import { createCombinedIndex } from "./engine.js";
import { parseAdblock } from "./parser/adblock.js";
import { parseHosts } from "./parser/hosts.js";
import {
  getState,
  saveCompiledIndex,
  saveCustomRules,
  saveLists,
  savePendingRebuild,
  saveRawLists,
} from "./storage.js";

export const ALARM_NAME = "update:index";
const MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

let compilePromise = null;

export async function addList({ name, url }) {
  const state = await getState();
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
  const state = await getState();
  const rawLists = { ...state.rawLists };
  delete rawLists[listId];
  await saveLists(state.lists.filter((list) => list.id !== listId));
  await saveRawLists(rawLists);
  await savePendingRebuild(true);
}

export async function updateListSettings(listId, patch) {
  const state = await getState();
  const lists = state.lists.map((list) =>
    list.id === listId ? { ...list, ...patch } : list,
  );
  await saveLists(lists);
  if ("enabled" in patch || "format" in patch) await savePendingRebuild(true);
}

export async function updateAllLists() {
  const state = await getState();
  const enabledLists = state.lists.filter((list) => list.enabled);
  const fetchResults = new Map();

  await Promise.allSettled(
    enabledLists.map(async (list) => {
      try {
        const result = await fetchList(list);
        if (result.notModified && !state.rawLists[list.id]) {
          throw new Error("Server returned not modified but no cached body.");
        }
        fetchResults.set(list.id, { ok: true, result });
      } catch (error) {
        fetchResults.set(list.id, { ok: false, error });
      }
    }),
  );

  const now = Date.now();
  const rawLists = { ...state.rawLists };
  const lists = state.lists.map((list) => {
    const outcome = fetchResults.get(list.id);
    if (!outcome) return list;
    if (!outcome.ok) return { ...list, lastError: outcome.error.message };
    const { result } = outcome;
    if (!result.notModified) rawLists[list.id] = result.text;
    return {
      ...list,
      lastError: null,
      etag: result.etag ?? list.etag,
      lastModified: result.lastModified ?? list.lastModified,
    };
  });

  await saveLists(lists);
  await saveRawLists(rawLists);
  await compileAndStoreIndex();
}

export async function updateCustomRules(rawRules) {
  const customRules = String(rawRules || "");
  parseCustomRules(customRules);
  await saveCustomRules(customRules);
  return compileAndStoreIndex();
}

export async function updateListNow(listId, { compile = true } = {}) {
  const state = await getState();
  const target = state.lists.find((list) => list.id === listId);
  if (!target) throw new Error("List not found");

  try {
    const result = await fetchList(target);
    if (result.notModified && !state.rawLists[listId]) {
      throw new Error(
        "The server returned not modified, but no cached list body is available.",
      );
    }
    const parsed = result.notModified
      ? parseListText(state.rawLists[listId], target.format)
      : parseListText(result.text, target.format);
    const now = Date.now();
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

    const rawLists = { ...state.rawLists };
    if (!result.notModified) rawLists[listId] = result.text;

    await saveLists(lists);
    await saveRawLists(rawLists);
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

  const state = await getState();
  const parsedLists = [];
  if (state.customRules.trim())
    parsedLists.push(parseCustomRules(state.customRules));

  const lists = state.lists.map((list) => {
    if (!list.enabled || !state.rawLists[list.id]) return list;
    try {
      const parsed = parseListText(state.rawLists[list.id], list.format);
      parsedLists.push(parsed);
      return {
        ...list,
        ruleCount: countRules(parsed),
        lastError: null,
      };
    } catch (error) {
      return { ...list, ruleCount: 0, lastError: error.message };
    }
  });

  const compiledIndex = createCombinedIndex(parsedLists);
  await saveCompiledIndex(compiledIndex);
  await saveLists(lists);
  return compiledIndex;
}

export async function reconcileAlarms() {
  if (!chrome.alarms) return;
  const state = await getState();
  const periodInMinutes =
    clampInterval(state.settings.updateIntervalDays) * 1440;
  const existing = await chrome.alarms.get(ALARM_NAME);

  if (periodInMinutes <= 0) {
    if (existing) await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  if (existing?.periodInMinutes === periodInMinutes) return;
  if (existing) await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
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
      regexBlocks: [],
      regexAllows: [],
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
    regexBlocks: [],
    regexAllows: [],
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
    (parsed.hostAllowsSubtree?.size || 0) +
    (parsed.regexBlocks?.length || 0) +
    (parsed.regexAllows?.length || 0)
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

async function fetchList(list) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {};
    if (list.etag) headers["If-None-Match"] = list.etag;
    if (list.lastModified) headers["If-Modified-Since"] = list.lastModified;

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
