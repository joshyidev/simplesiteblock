import {
  EMPTY_SERIALIZED_INDEX,
  countIndexRules,
  hydrateIndex,
} from "./engine.js";
import { extensionApi as ext } from "../extension_api.js";

const EMPTY_INDEX_STATS = Object.freeze({ total: 0, builtAt: 0 });
const RAW_LIST_PREFIX = "rawList:";

function buildIndexStats(index) {
  return { total: countIndexRules(index), builtAt: index?.builtAt || 0 };
}

function normalizeIndexStats(stats) {
  if (stats && typeof stats === "object") {
    return {
      total: Number(stats.total) || 0,
      builtAt: Number(stats.builtAt) || 0,
    };
  }
  return EMPTY_INDEX_STATS;
}

export const DEFAULT_SETTINGS = Object.freeze({
  blockAction: "show_block_page",
  passwordEnabled: false,
  password: "",
  lastUnlockAt: 0,
  updateIntervalDays: 7,
});

export async function ensureDefaults() {
  const stored = await ext.storage.local.get([
    "settings",
    "lists",
    "customRules",
  ]);
  const toWrite = {};
  if (!stored.settings || typeof stored.settings !== "object") {
    toWrite.settings = DEFAULT_SETTINGS;
  } else if (
    Object.keys(DEFAULT_SETTINGS).some((k) => !(k in stored.settings))
  ) {
    toWrite.settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  }
  if (!Array.isArray(stored.lists)) toWrite.lists = [];
  if (typeof stored.customRules !== "string") toWrite.customRules = "";
  if (Object.keys(toWrite).length > 0) await ext.storage.local.set(toWrite);
  return getState({ includeRawLists: false, includeCompiledIndex: false });
}

export async function getState({
  includeRawLists = false,
  includeCompiledIndex = true,
} = {}) {
  const request = {
    settings: DEFAULT_SETTINGS,
    lists: [],
    customRules: "",
    indexStats: null,
    pendingRebuild: false,
  };
  // compiledIndex holds every compiled host and can be many MB for large lists.
  // Only fetch it when a caller actually needs it, so the options page does not
  // pay to deserialize it. Cached raw list bodies are stored per-list; callers
  // should use getRawList() instead of loading every body at once.
  if (includeRawLists) request.rawLists = {};
  if (includeCompiledIndex) request.compiledIndex = EMPTY_SERIALIZED_INDEX;

  const stored = await ext.storage.local.get(request);

  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    lists: Array.isArray(stored.lists) ? stored.lists : [],
    rawLists:
      includeRawLists && stored.rawLists && typeof stored.rawLists === "object"
        ? stored.rawLists
        : {},
    customRules:
      typeof stored.customRules === "string" ? stored.customRules : "",
    compiledIndex: includeCompiledIndex
      ? stored.compiledIndex || EMPTY_SERIALIZED_INDEX
      : EMPTY_SERIALIZED_INDEX,
    indexStats: normalizeIndexStats(stored.indexStats),
    pendingRebuild: Boolean(stored.pendingRebuild),
  };
}

export async function getHydratedState() {
  const state = await getState({ includeRawLists: false });
  return { ...state, index: hydrateIndex(state.compiledIndex) };
}

export async function saveSettings(settingsPatch) {
  const state = await getState({
    includeRawLists: false,
    includeCompiledIndex: false,
  });
  const settings = { ...state.settings, ...settingsPatch };
  await ext.storage.local.set({ settings });
  return settings;
}

export async function saveLists(lists) {
  await ext.storage.local.set({ lists });
  return lists;
}

export function rawListStorageKey(listId) {
  return `${RAW_LIST_PREFIX}${listId}`;
}

export function isRawListStorageKey(key) {
  return typeof key === "string" && key.startsWith(RAW_LIST_PREFIX);
}

export async function getRawList(listId) {
  const key = rawListStorageKey(listId);
  const stored = await ext.storage.local.get({ [key]: null });
  return typeof stored[key] === "string" ? stored[key] : null;
}

export async function saveRawList(listId, text) {
  await ext.storage.local.set({ [rawListStorageKey(listId)]: String(text) });
}

export async function removeRawList(listId) {
  const key = rawListStorageKey(listId);
  if (ext.storage.local.remove) {
    await ext.storage.local.remove(key);
    return;
  }
  await ext.storage.local.set({ [key]: null });
}

export async function saveCustomRules(customRules) {
  await ext.storage.local.set({ customRules });
  return customRules;
}

export async function saveCompiledIndex(compiledIndex) {
  await ext.storage.local.set({
    compiledIndex,
    indexStats: buildIndexStats(compiledIndex),
    pendingRebuild: false,
  });
  return compiledIndex;
}

export async function savePendingRebuild(pending) {
  await ext.storage.local.set({ pendingRebuild: pending });
}

export async function getStorageBytesInUse() {
  if (!ext.storage.local.getBytesInUse) return null;
  return ext.storage.local.getBytesInUse(null);
}
