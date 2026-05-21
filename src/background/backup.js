import {
  compileAndStoreIndex,
  normalizeListUrl,
  parseCustomRules,
  reconcileAlarms,
} from "./lists.js";
import { DEFAULT_SETTINGS, savePendingRebuild } from "./storage.js";

const EXPORT_APP = "SimpleSiteBlock";
const EXPORT_VERSION = 1;
const BLOCK_ACTIONS = new Set(["show_block_page", "close_tab"]);
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
  parseCustomRules(customRules);

  const lists = sanitizeLists(payload.lists || []);

  return { settings, lists, rawLists: {}, customRules };
}

export async function importSettingsBackup(text) {
  const imported = parseSettingsImport(text);
  await chrome.storage.local.set({
    settings: imported.settings,
    lists: imported.lists,
    rawLists: imported.rawLists,
    customRules: imported.customRules,
  });
  await compileAndStoreIndex();
  await savePendingRebuild(hasEnabledListWithoutRawText(imported));
  await reconcileAlarms();
}

function exportSettings(settings) {
  return {
    blockAction: validBlockAction(settings.blockAction)
      ? settings.blockAction
      : DEFAULT_SETTINGS.blockAction,
    updateIntervalDays: validUpdateInterval(settings.updateIntervalDays)
      ? settings.updateIntervalDays
      : DEFAULT_SETTINGS.updateIntervalDays,
  };
}

function importSettings(settings, password) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Settings are missing or invalid.");
  }
  if (!validBlockAction(settings.blockAction)) {
    throw new Error("Block action setting is invalid.");
  }
  if (!validUpdateInterval(settings.updateIntervalDays)) {
    throw new Error("Auto-update interval setting is invalid.");
  }

  const passwordSettings =
    password === undefined
      ? { passwordEnabled: false, passwordHash: null }
      : importPasswordSettings(password);

  return {
    ...DEFAULT_SETTINGS,
    blockAction: settings.blockAction,
    updateIntervalDays: settings.updateIntervalDays,
    ...passwordSettings,
    lastUnlockAt: 0,
  };
}

function exportPasswordSettings(settings) {
  const enabled = Boolean(settings.passwordEnabled);
  return {
    passwordEnabled: enabled,
    passwordHash: enabled ? settings.passwordHash || null : null,
  };
}

function importPasswordSettings(password) {
  if (!password || typeof password !== "object" || Array.isArray(password)) {
    throw new Error("Password settings are invalid.");
  }
  const passwordEnabled = Boolean(password.passwordEnabled);
  if (!passwordEnabled) {
    return { passwordEnabled: false, passwordHash: null };
  }
  if (!isPasswordHash(password.passwordHash)) {
    throw new Error("Password hash is missing or invalid.");
  }
  return {
    passwordEnabled: true,
    passwordHash: { ...password.passwordHash },
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
      lastError:
        typeof list.lastError === "string" ? list.lastError : null,
      etag: typeof list.etag === "string" ? list.etag : null,
      lastModified:
        typeof list.lastModified === "string" ? list.lastModified : null,
      ruleCount: validRuleCount(list.ruleCount) ? list.ruleCount : 0,
    };
  });
}

function validBlockAction(value) {
  return BLOCK_ACTIONS.has(value);
}

function validUpdateInterval(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function validRuleCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPasswordHash(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.algo === "PBKDF2-SHA-256" &&
    typeof value.salt === "string" &&
    typeof value.hash === "string" &&
    Number.isInteger(value.iterations) &&
    value.iterations > 0
  );
}

function hasEnabledListWithoutRawText({ lists }) {
  return lists.some((list) => list.enabled);
}
