import { EMPTY_SERIALIZED_INDEX, hydrateIndex } from "./engine.js";

export const DEFAULT_SETTINGS = Object.freeze({
  blockAction: "show_block_page",
  passwordEnabled: false,
  passwordHash: null,
  lastUnlockAt: 0,
});

export async function ensureDefaults() {
  const state = await getState();
  await chrome.storage.local.set({
    settings: state.settings,
    lists: state.lists,
    rawLists: state.rawLists,
    compiledIndex: state.compiledIndex,
  });
  return state;
}

export async function getState() {
  const stored = await chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    lists: [],
    rawLists: {},
    compiledIndex: EMPTY_SERIALIZED_INDEX,
  });

  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    lists: Array.isArray(stored.lists) ? stored.lists : [],
    rawLists:
      stored.rawLists && typeof stored.rawLists === "object"
        ? stored.rawLists
        : {},
    compiledIndex: stored.compiledIndex || EMPTY_SERIALIZED_INDEX,
  };
}

export async function getHydratedState() {
  const state = await getState();
  return { ...state, index: hydrateIndex(state.compiledIndex) };
}

export async function saveSettings(settingsPatch) {
  const state = await getState();
  const settings = { ...state.settings, ...settingsPatch };
  await chrome.storage.local.set({ settings });
  return settings;
}

export async function saveLists(lists) {
  await chrome.storage.local.set({ lists });
  return lists;
}

export async function saveRawLists(rawLists) {
  await chrome.storage.local.set({ rawLists });
  return rawLists;
}

export async function saveCompiledIndex(compiledIndex) {
  await chrome.storage.local.set({ compiledIndex });
  return compiledIndex;
}

export async function getStorageBytesInUse() {
  if (!chrome.storage.local.getBytesInUse) return null;
  return chrome.storage.local.getBytesInUse(null);
}
