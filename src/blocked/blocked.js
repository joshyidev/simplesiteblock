import { extensionApi as ext } from "../extension_api.js";

// The HTML carries the default message; only override it when the user has set
// a custom one. textContent keeps the user's text inert (no HTML injection).
ext.storage.local.get({ settings: {} }).then((stored) => {
  const message = stored.settings?.blockPageMessage;
  if (typeof message === "string" && message.trim()) {
    document.querySelector("#blockMessage").textContent = message;
  }
});
