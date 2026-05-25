import assert from "node:assert/strict";
import test from "node:test";
import { extensionApi } from "../src/extension_api.js";

test("extension API shim resolves the chrome global", () => {
  const originalChrome = globalThis.chrome;

  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ name: "Chrome" }),
    },
  };

  try {
    assert.equal(extensionApi.runtime.getManifest().name, "Chrome");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("extension API shim throws when chrome is unavailable", () => {
  const originalChrome = globalThis.chrome;

  delete globalThis.chrome;

  try {
    assert.throws(() => extensionApi.runtime, /Extension API is unavailable/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
