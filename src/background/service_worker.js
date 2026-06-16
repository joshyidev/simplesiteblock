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

void initialize();

async function initialize() {
  await ensureDefaults();
  await reconcileRules();
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
