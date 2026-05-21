import { getState, saveSettings } from "./background/storage.js";

const THEMES = new Set(["system", "light", "dark"]);
const THEME_CACHE_KEY = "simpleSiteBlockTheme";

export function normalizeTheme(theme) {
  return THEMES.has(theme) ? theme : "system";
}

export function resolvedTheme(theme) {
  const normalized = normalizeTheme(theme);
  if (normalized !== "system") return normalized;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  if (normalized === "system") {
    document.documentElement.removeAttribute("data-theme");
    cacheTheme(normalized);
    return;
  }
  document.documentElement.dataset.theme = normalized;
  cacheTheme(normalized);
}

export async function loadAndApplyTheme() {
  const state = await getState();
  applyTheme(state.settings.theme);
  return normalizeTheme(state.settings.theme);
}

export async function saveAndApplyTheme(theme) {
  const normalized = normalizeTheme(theme);
  applyTheme(normalized);
  await saveSettings({ theme: normalized });
  return normalized;
}

export function watchThemeChanges(onThemeChange) {
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.settings) return;
    const theme = normalizeTheme(changes.settings.newValue?.theme);
    applyTheme(theme);
    onThemeChange?.(theme);
  });
}

function cacheTheme(theme) {
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // A stale cache only affects first paint; storage remains the source of truth.
  }
}
