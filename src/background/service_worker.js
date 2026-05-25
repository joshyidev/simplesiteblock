import { evaluate } from "./engine.js";
import { extensionApi as ext } from "../extension_api.js";
import { importSettingsBackup } from "./backup.js";
import { ensureDefaults, getHydratedState } from "./storage.js";
import {
  compileAndStoreIndex,
  handleAlarm,
  reconcileAlarms,
  updateAllLists,
  updateCustomRules,
} from "./lists.js";

const KEEP_ALIVE_INTERVAL_MS = 20000;

let stateReady = null;

ext.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  void handleNavigation(details);
});

ext.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ssb:verdict") {
    void respondWithVerdict(message.url, sendResponse);
    return true; // keep the channel open for the async response
  }
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
  return false;
});

ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  // Navigation only reads settings and the hydrated compiled index. Raw-list
  // writes during updates should not rehydrate the whole index repeatedly.
  if (changes.settings || changes.compiledIndex) {
    warmState();
  }
  if (changes.settings || changes.lists || changes.customRules) {
    void reconcileAlarms();
  }
});

keepWorkerWarm();
void initialize();

// Top-level navigation blocking runs on webNavigation.onBeforeNavigate, which
// observes a navigation rather than holding it: the page begins loading and the
// worker reacts by redirecting or closing the tab. If the worker has been torn
// down (MV3 terminates it after ~30s idle), the next navigation must cold-start
// it and rehydrate the index before it can decide, which lets the destination
// page paint for a moment before the block lands. A periodic extension API call
// resets the idle timer so the worker stays warm and verdicts are immediate.
// The browser may still terminate the worker under memory pressure or on
// restart; module load re-arms this each time the worker starts.
function keepWorkerWarm() {
  setInterval(() => {
    ext.runtime.getPlatformInfo().catch(() => {});
    void loadState();
  }, KEEP_ALIVE_INTERVAL_MS);
}

async function initialize() {
  const state = await ensureDefaults();
  if (!state.indexStats.builtAt) await compileAndStoreIndex();
  await reconcileAlarms();
  warmState();
}

async function loadState() {
  if (!stateReady) stateReady = getHydratedState();
  return stateReady;
}

// Read-only verdict for the options-page diagnostics test. Evaluates against the
// warm in-memory index so the options page never has to deserialize it. Does not
// apply any block action.
async function respondWithVerdict(url, sendResponse) {
  try {
    const state = await loadState();
    const verdict = evaluate(url, state.index);
    sendResponse({ blocked: verdict.blocked, reason: verdict.reason });
  } catch {
    sendResponse(null);
  }
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

function warmState() {
  const nextState = getHydratedState();
  stateReady = nextState;
  nextState.catch(() => {
    if (stateReady === nextState) stateReady = null;
  });
}

async function handleNavigation(details) {
  const state = await loadState();
  const verdict = evaluate(details.url, state.index);
  if (!verdict.blocked) return;

  // Incognito always closes: under spanning incognito mode an on-the-record
  // extension page cannot load in an off-the-record tab, so navigating to
  // blocked.html there fails with ERR_BLOCKED_BY_CLIENT.
  if (
    state.settings.blockAction === "close_tab" ||
    (await isIncognitoTab(details.tabId))
  ) {
    ext.tabs.remove(details.tabId).catch(() => {});
    return;
  }

  const target = ext.runtime.getURL(
    `src/blocked/blocked.html?url=${encodeURIComponent(details.url)}&reason=${encodeURIComponent(verdict.reason)}`,
  );
  ext.tabs.update(details.tabId, { url: target }).catch(() => {});
}

async function isIncognitoTab(tabId) {
  try {
    const tab = await ext.tabs.get(tabId);
    return Boolean(tab.incognito);
  } catch {
    return false;
  }
}
