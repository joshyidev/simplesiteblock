import {
  EMPTY_SERIALIZED_INDEX,
  countIndexRules,
  hydrateIndex,
} from "./engine.js";
import { extensionApi as ext } from "../extension_api.js";

const EMPTY_INDEX_STATS = Object.freeze({ total: 0, builtAt: 0 });

function buildIndexStats(index) {
  return { total: countIndexRules(index), builtAt: index?.builtAt || 0 };
}

function normalizeIndexStats(stats) {
  if (stats && typeof stats === "object") {
    return { total: Number(stats.total) || 0, builtAt: Number(stats.builtAt) || 0 };
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
  const stored = await ext.storage.local.get(["settings", "lists", "customRules"]);
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
  includeRawLists = true,
  includeCompiledIndex = true,
} = {}) {
  const request = {
    settings: DEFAULT_SETTINGS,
    lists: [],
    customRules: "",
    indexStats: null,
    pendingRebuild: false,
  };
  // rawLists holds the full text of every list and compiledIndex holds every
  // compiled host (both many MB for large lists). Only fetch them when a caller
  // actually needs them, so the options page and navigation path do not pay to
  // deserialize them. indexStats is a tiny summary used for display.
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
  const state = await getState();
  const settings = { ...state.settings, ...settingsPatch };
  await ext.storage.local.set({ settings });
  return settings;
}

export async function saveLists(lists) {
  await ext.storage.local.set({ lists });
  return lists;
}

export async function saveRawLists(rawLists) {
  await ext.storage.local.set({ rawLists });
  return rawLists;
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
