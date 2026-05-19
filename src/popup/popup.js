const manifest = chrome.runtime.getManifest();

document.querySelector("#extensionName").textContent = manifest.name;
document.querySelector("#extensionVersion").textContent =
  `Version ${manifest.version}`;

document.querySelector("#openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
