import assert from "node:assert/strict";
import test from "node:test";
import { extensionApi } from "../src/extension_api.js";

test("extension API shim prefers browser over chrome", () => {
  const originalBrowser = globalThis.browser;
  const originalChrome = globalThis.chrome;

  globalThis.browser = {
    runtime: {
      getManifest: () => ({ name: "Browser" }),
    },
  };
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ name: "Chrome" }),
    },
  };

  try {
    assert.equal(extensionApi.runtime.getManifest().name, "Browser");
  } finally {
    globalThis.browser = originalBrowser;
    globalThis.chrome = originalChrome;
  }
});

test("extension API shim falls back to chrome", () => {
  const originalBrowser = globalThis.browser;
  const originalChrome = globalThis.chrome;

  delete globalThis.browser;
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ name: "Chrome" }),
    },
  };

  try {
    assert.equal(extensionApi.runtime.getManifest().name, "Chrome");
  } finally {
    globalThis.browser = originalBrowser;
    globalThis.chrome = originalChrome;
  }
});
