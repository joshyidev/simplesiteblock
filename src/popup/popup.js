import {
  loadAndApplyTheme,
  watchThemeChanges,
} from "../theme.js";

const manifest = chrome.runtime.getManifest();

document.querySelector("#extensionName").textContent = manifest.name;
document.querySelector("#extensionVersion").textContent =
  `Version ${manifest.version}`;

void loadAndApplyTheme();
watchThemeChanges();

document.querySelector("#openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
