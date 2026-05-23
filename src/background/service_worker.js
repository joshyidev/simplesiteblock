import { evaluate } from "./engine.js";
import { extensionApi as ext } from "../extension_api.js";
import { ensureDefaults, getHydratedState } from "./storage.js";
import { compileAndStoreIndex, handleAlarm, reconcileAlarms } from "./lists.js";

let stateReady = null;

ext.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  void handleNavigation(details);
});

ext.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});

ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (
    changes.settings ||
    changes.compiledIndex ||
    changes.lists ||
    changes.rawLists ||
    changes.customRules
  ) {
    warmState();
  }
  if (
    changes.settings ||
    changes.lists ||
    changes.rawLists ||
    changes.customRules
  ) {
    void reconcileAlarms();
  }
});

void initialize();

async function initialize() {
  const state = await ensureDefaults();
  if (!state.compiledIndex?.builtAt) await compileAndStoreIndex();
  await reconcileAlarms();
  warmState();
}

async function loadState() {
  if (!stateReady) stateReady = getHydratedState();
  return stateReady;
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
