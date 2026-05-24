import { EMPTY_SERIALIZED_INDEX, hydrateIndex } from "./engine.js";
import { extensionApi as ext } from "../extension_api.js";

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
    "rawLists",
    "customRules",
    "compiledIndex",
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
  if (!stored.rawLists || typeof stored.rawLists !== "object")
    toWrite.rawLists = {};
  if (typeof stored.customRules !== "string") toWrite.customRules = "";
  if (!stored.compiledIndex) toWrite.compiledIndex = EMPTY_SERIALIZED_INDEX;
  if (Object.keys(toWrite).length > 0) await ext.storage.local.set(toWrite);
  return getState();
}

export async function getState() {
  const stored = await ext.storage.local.get({
    settings: DEFAULT_SETTINGS,
    lists: [],
    rawLists: {},
    customRules: "",
    compiledIndex: EMPTY_SERIALIZED_INDEX,
    pendingRebuild: false,
  });

  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    lists: Array.isArray(stored.lists) ? stored.lists : [],
    rawLists:
      stored.rawLists && typeof stored.rawLists === "object"
        ? stored.rawLists
        : {},
    customRules:
      typeof stored.customRules === "string" ? stored.customRules : "",
    compiledIndex: stored.compiledIndex || EMPTY_SERIALIZED_INDEX,
    pendingRebuild: Boolean(stored.pendingRebuild),
  };
}

export async function getHydratedState() {
  const state = await getState();
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
  await ext.storage.local.set({ compiledIndex, pendingRebuild: false });
  return compiledIndex;
}

export async function savePendingRebuild(pending) {
  await ext.storage.local.set({ pendingRebuild: pending });
}

export async function getStorageBytesInUse() {
  if (!ext.storage.local.getBytesInUse) return null;
  return ext.storage.local.getBytesInUse(null);
}
