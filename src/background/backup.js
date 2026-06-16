import {
  assertCustomRulesWithinLimit,
  normalizeListUrl,
  parseCustomRules,
  rebuildAll,
  reconcileAlarms,
} from "./lists.js";
import { DEFAULT_SETTINGS, getState, removeRawList } from "./storage.js";
import { extensionApi as ext } from "../extension_api.js";

const EXPORT_APP = "SimpleSiteBlock";
const EXPORT_VERSION = 1;
const LIST_FORMATS = new Set(["auto", "hosts", "adblock"]);

export function createSettingsExport(state, { includePassword = false } = {}) {
  const lists = sanitizeLists(state.lists || []);
  const payload = {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: exportSettings(state.settings || {}),
    lists,
    customRules: typeof state.customRules === "string" ? state.customRules : "",
  };

  if (includePassword) {
    payload.password = exportPasswordSettings(state.settings || {});
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseSettingsImport(text) {
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    throw new Error("Choose a valid SimpleSiteBlock settings file.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Choose a valid SimpleSiteBlock settings file.");
  }
  if (payload.app !== EXPORT_APP) {
    throw new Error("This file is not a SimpleSiteBlock settings export.");
  }
  if (payload.version !== EXPORT_VERSION) {
    throw new Error("This settings export version is not supported.");
  }
  if ("compiledIndex" in payload) {
    throw new Error("Settings exports must not include a compiled index.");
  }

  const settings = importSettings(payload.settings || {}, payload.password);
  const customRules =
    typeof payload.customRules === "string" ? payload.customRules : "";
  assertCustomRulesWithinLimit(parseCustomRules(customRules));

  const lists = sanitizeLists(payload.lists || []);

  return { settings, lists, rawLists: {}, customRules };
}

export async function importSettingsBackup(text) {
  const existing = await getState({ includeRawLists: false });
  const imported = parseSettingsImport(text);
  const rawListIdsToClear = new Set([
    ...existing.lists.map((list) => list.id),
    ...imported.lists.map((list) => list.id),
  ]);
  await Promise.all(
    [...rawListIdsToClear].map((listId) => removeRawList(listId)),
  );
  await ext.storage.local.set({
    settings: imported.settings,
    lists: imported.lists,
    rawLists: {},
    customRules: imported.customRules,
  });
  // Imported lists arrive without cached bodies; rebuildAll applies custom rules
  // now and flags pendingRebuild until the lists are fetched.
  await rebuildAll();
  await reconcileAlarms();
}

function exportSettings(settings) {
  return {
    updateIntervalDays: validUpdateInterval(settings.updateIntervalDays)
      ? settings.updateIntervalDays
      : DEFAULT_SETTINGS.updateIntervalDays,
    blockAction: validBlockAction(settings.blockAction)
      ? settings.blockAction
      : DEFAULT_SETTINGS.blockAction,
  };
}

function importSettings(settings, password) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Settings are missing or invalid.");
  }
  if (!validUpdateInterval(settings.updateIntervalDays)) {
    throw new Error("Auto-update interval setting is invalid.");
  }

  const passwordSettings =
    password === undefined
      ? { passwordEnabled: false, password: "" }
      : importPasswordSettings(password);

  return {
    ...DEFAULT_SETTINGS,
    updateIntervalDays: settings.updateIntervalDays,
    blockAction: validBlockAction(settings.blockAction)
      ? settings.blockAction
      : DEFAULT_SETTINGS.blockAction,
    ...passwordSettings,
    lastUnlockAt: 0,
  };
}

function exportPasswordSettings(settings) {
  const enabled = Boolean(settings.passwordEnabled);
  return {
    passwordEnabled: enabled,
    password: enabled ? String(settings.password || "") : "",
  };
}

function importPasswordSettings(password) {
  if (!password || typeof password !== "object" || Array.isArray(password)) {
    throw new Error("Password settings are invalid.");
  }
  const passwordEnabled = Boolean(password.passwordEnabled);
  if (!passwordEnabled) {
    return { passwordEnabled: false, password: "" };
  }
  if (typeof password.password !== "string" || password.password === "") {
    throw new Error("Password is missing or invalid.");
  }
  return {
    passwordEnabled: true,
    password: password.password,
  };
}

function sanitizeLists(lists) {
  if (!Array.isArray(lists)) throw new Error("List settings are invalid.");

  const ids = new Set();
  const urls = new Set();
  return lists.map((list) => {
    if (!list || typeof list !== "object" || Array.isArray(list)) {
      throw new Error("List settings are invalid.");
    }

    const id = String(list.id || "").trim();
    if (!id || ids.has(id)) throw new Error("List IDs must be unique.");
    ids.add(id);

    const url = normalizeListUrl(list.url);
    if (urls.has(url)) throw new Error("List URLs must be unique.");
    urls.add(url);

    const format = list.format || "auto";
    if (!LIST_FORMATS.has(format)) throw new Error("List format is invalid.");
    if (list.enabled !== undefined && typeof list.enabled !== "boolean") {
      throw new Error("List enabled setting is invalid.");
    }

    const name = String(list.name || "").trim() || new URL(url).hostname;

    return {
      id,
      name,
      url,
      format,
      enabled: list.enabled !== false,
      lastError: null,
      etag: null,
      lastModified: null,
      ruleCount: 0,
    };
  });
}

function validUpdateInterval(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function validBlockAction(value) {
  return value === "redirect" || value === "close";
}
