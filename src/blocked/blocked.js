import {
  loadAndApplyTheme,
  watchThemeChanges,
} from "../theme.js";

void loadAndApplyTheme();
watchThemeChanges();

const params = new URLSearchParams(location.search);
document.querySelector("#blockedUrl").textContent =
  params.get("url") || "Unknown";
document.querySelector("#blockedReason").textContent =
  params.get("reason") || "Unknown";
