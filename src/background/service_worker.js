import { evaluate } from "./engine.js";
import { ensureDefaults, getHydratedState } from "./storage.js";
import { compileAndStoreIndex, handleAlarm, reconcileAlarms } from "./lists.js";

let stateReady = null;

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  void handleNavigation(details);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.settings || changes.compiledIndex) stateReady = null;
  if (changes.lists || changes.rawLists) {
    stateReady = null;
    void reconcileAlarms();
  }
});

void initialize();

async function initialize() {
  const state = await ensureDefaults();
  if (!state.compiledIndex?.builtAt) await compileAndStoreIndex();
  await reconcileAlarms();
  stateReady = null;
}

async function loadState() {
  if (!stateReady) stateReady = getHydratedState();
  return stateReady;
}

async function handleNavigation(details) {
  const state = await loadState();
  const verdict = evaluate(details.url, state.index);
  if (!verdict.blocked) return;

  if (
    state.settings.blockAction === "close_tab" ||
    (await isIncognitoTab(details.tabId))
  ) {
    chrome.tabs.remove(details.tabId).catch(() => {});
    return;
  }

  const target = chrome.runtime.getURL(
    `src/blocked/blocked.html?url=${encodeURIComponent(details.url)}&reason=${encodeURIComponent(verdict.reason)}`,
  );
  chrome.tabs.update(details.tabId, { url: target }).catch(() => {});
}

async function isIncognitoTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab.incognito);
  } catch {
    return false;
  }
}
