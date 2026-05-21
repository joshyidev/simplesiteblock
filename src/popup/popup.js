import { extensionApi as ext } from "../extension_api.js";

const manifest = ext.runtime.getManifest();

document.querySelector("#extensionName").textContent = manifest.name;
document.querySelector("#extensionVersion").textContent =
  `Version ${manifest.version}`;

document.querySelector("#openOptions").addEventListener("click", () => {
  ext.runtime.openOptionsPage();
});
