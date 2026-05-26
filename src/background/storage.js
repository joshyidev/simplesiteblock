import { extensionApi as ext } from "../extension_api.js";

const RAW_LIST_PREFIX = "rawList:";

export const DEFAULT_SETTINGS = Object.freeze({
  passwordEnabled: false,
  password: "",
  lastUnlockAt: 0,
  updateIntervalDays: 7,
  blockPageMessage: "",
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
  return getState({ includeRawLists: false });
}

export async function getState({ includeRawLists = false } = {}) {
  const request = {
    settings: DEFAULT_SETTINGS,
    lists: [],
    customRules: "",
    pendingRebuild: false,
    rulesBuiltAt: 0,
    appliedSignature: "",
    appliedListDomainCount: 0,
    appliedCustomDomainCount: 0,
  };
  // Cached raw list bodies are stored per-list; callers should use getRawList()
  // instead of loading every body at once.
  if (includeRawLists) request.rawLists = {};

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
    pendingRebuild: Boolean(stored.pendingRebuild),
    rulesBuiltAt: Number(stored.rulesBuiltAt) || 0,
    appliedSignature:
      typeof stored.appliedSignature === "string"
        ? stored.appliedSignature
        : "",
    appliedListDomainCount: Number(stored.appliedListDomainCount) || 0,
    appliedCustomDomainCount: Number(stored.appliedCustomDomainCount) || 0,
  };
}

export async function saveSettings(settingsPatch) {
  const state = await getState({ includeRawLists: false });
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

export async function savePendingRebuild(pending) {
  await ext.storage.local.set({ pendingRebuild: pending });
}

export async function saveRulesBuiltAt(timestamp) {
  await ext.storage.local.set({ rulesBuiltAt: timestamp });
}

export async function saveAppliedSignature(signature) {
  await ext.storage.local.set({ appliedSignature: signature });
}

export async function saveListDomainCount(count) {
  await ext.storage.local.set({ appliedListDomainCount: count });
}

export async function saveCustomDomainCount(count) {
  await ext.storage.local.set({ appliedCustomDomainCount: count });
}

export async function getStorageBytesInUse() {
  if (!ext.storage.local.getBytesInUse) return null;
  return ext.storage.local.getBytesInUse(null);
}
