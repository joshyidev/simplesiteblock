import { extensionApi as ext } from "../extension_api.js";
import { importSettingsBackup } from "./backup.js";
import { lookupHost } from "./lookup.js";
import { registerNavigationGuard } from "./navigation_guard.js";
import { ensureDefaults } from "./storage.js";
import {
  handleAlarm,
  reconcileAlarms,
  reconcileRules,
  updateAllLists,
  updateCustomRules,
} from "./lists.js";

ext.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ssb:update-all-lists") {
    void respondWithCommand(() => updateAllLists(), sendResponse);
    return true;
  }
  if (message?.type === "ssb:update-custom-rules") {
    void respondWithCommand(
      () => updateCustomRules(message.rawRules),
      sendResponse,
    );
    return true;
  }
  if (message?.type === "ssb:import-settings") {
    void respondWithCommand(
      () => importSettingsBackup(message.text),
      sendResponse,
    );
    return true;
  }
  if (message?.type === "ssb:lookup") {
    void respondWithLookup(message.input, sendResponse);
    return true;
  }
  return false;
});

ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.settings || changes.lists || changes.customRules) {
    void reconcileAlarms();
  }
});

registerNavigationGuard();

// reconcileRules() reads the full dynamic ruleset (getDynamicRules), so keep it
// off the per-wake path: applied rules only drift from config across an install/
// reload (orphans inherited from a prior install) or a browser restart (rules
// that vanished). Both are covered here. Plain navigation/message wakes skip it.
ext.runtime.onInstalled.addListener(() => {
  void reconcileRules();
});
ext.runtime.onStartup.addListener(() => {
  void reconcileRules();
});

void initialize();

// Runs on every worker wake. Kept cheap: small storage reads only, no
// getDynamicRules. Reconciliation of applied rules is install/startup-scoped above.
async function initialize() {
  await ensureDefaults();
  await reconcileAlarms();
}

async function respondWithCommand(command, sendResponse) {
  try {
    await command();
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error?.message || "Something went wrong.",
    });
  }
}

async function respondWithLookup(input, sendResponse) {
  try {
    sendResponse(await lookupHost(input));
  } catch {
    sendResponse({ ok: false, error: "Lookup failed." });
  }
}
