import { extensionApi as ext } from "../extension_api.js";

const RAW_LIST_PREFIX = "rawList:";

export const DEFAULT_SETTINGS = Object.freeze({
  passwordEnabled: false,
  password: "",
  unlockDelaySeconds: 0,
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
  return getState({ includeRawLists: false });
}

export async function getState({ includeRawLists = false } = {}) {
  const request = {
    settings: DEFAULT_SETTINGS,
    lists: [],
    customRules: "",
    guardCacheVersion: "",
    lastListUpdateAttemptAt: 0,
    lastListUpdateCompletedAt: 0,
    appliedListDomainCount: 0,
    appliedCustomDomainCount: 0,
    appliedListRuleCount: 0,
    appliedCustomRuleCount: 0,
    lastListBuildError: null,
    lastCustomBuildError: null,
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
    guardCacheVersion:
      typeof stored.guardCacheVersion === "string"
        ? stored.guardCacheVersion
        : "",
    lastListUpdateAttemptAt: Number(stored.lastListUpdateAttemptAt) || 0,
    lastListUpdateCompletedAt: Number(stored.lastListUpdateCompletedAt) || 0,
    appliedListDomainCount: Number(stored.appliedListDomainCount) || 0,
    appliedCustomDomainCount: Number(stored.appliedCustomDomainCount) || 0,
    appliedListRuleCount: Number(stored.appliedListRuleCount) || 0,
    appliedCustomRuleCount: Number(stored.appliedCustomRuleCount) || 0,
    lastListBuildError: coerceBuildError(stored.lastListBuildError),
    lastCustomBuildError: coerceBuildError(stored.lastCustomBuildError),
  };
}

function coerceBuildError(value) {
  return typeof value === "string" && value !== "" ? value : null;
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

export async function saveListsWithRawList(lists, { listId, text }) {
  const patch = { lists };
  if (typeof text === "string") {
    patch[rawListStorageKey(listId)] = text;
  }
  await ext.storage.local.set(patch);
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

export async function saveLastListUpdateAttemptAt(timestamp) {
  await ext.storage.local.set({ lastListUpdateAttemptAt: timestamp });
}

export async function saveLastListUpdateCompletedAt(timestamp) {
  await ext.storage.local.set({ lastListUpdateCompletedAt: timestamp });
}

// Build errors are tracked per slice so clearing one cannot erase a standing
// failure on the other — startup reconciliation often rebuilds only one of them.
export async function saveSliceBuildError(slice, message) {
  await ext.storage.local.set({
    [slice === "custom" ? "lastCustomBuildError" : "lastListBuildError"]:
      message ?? null,
  });
}

// Everything derived from one applied rule slice commits in a single write: the
// navigation guard's host sets are a parallel cache of what DNR is enforcing, so
// a worker death between separate writes could leave the guard matching against
// hosts the applied rules no longer contain. guardCacheVersion is the guard's
// cache key, replaced in the same write that changes what it should be caching.
export async function saveAppliedListSlice({
  block,
  allow,
  ruleCount,
  guardCacheVersion,
}) {
  await ext.storage.local.set({
    guardHostsList: serializeGuardHosts(block, allow),
    appliedListDomainCount: block.size,
    appliedListRuleCount: ruleCount,
    guardCacheVersion,
  });
}

export async function saveAppliedCustomSlice({
  block,
  allow,
  ruleCount,
  guardCacheVersion,
}) {
  await ext.storage.local.set({
    guardHostsCustom: serializeGuardHosts(block, allow),
    appliedCustomDomainCount: block.size,
    appliedCustomRuleCount: ruleCount,
    guardCacheVersion,
  });
}

function serializeGuardHosts(block, allow) {
  return { block: [...block], allow: [...allow] };
}

export async function getGuardHosts() {
  const stored = await ext.storage.local.get({
    guardHostsList: { block: [], allow: [] },
    guardHostsCustom: { block: [], allow: [] },
  });
  return {
    list: coerceGuardHosts(stored.guardHostsList),
    custom: coerceGuardHosts(stored.guardHostsCustom),
  };
}

function coerceGuardHosts(value) {
  return {
    block: Array.isArray(value?.block) ? value.block : [],
    allow: Array.isArray(value?.allow) ? value.allow : [],
  };
}

export async function getStorageBytesInUse() {
  if (!ext.storage.local.getBytesInUse) return null;
  return ext.storage.local.getBytesInUse(null);
}
