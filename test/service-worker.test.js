import assert from "node:assert/strict";
import test from "node:test";

test("service worker routes list CRUD through background commands", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const store = {};
  let onMessage;

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, store[key]]));
          }
          return { ...(keys || {}), ...store };
        },
        async set(patch) {
          Object.assign(store, patch);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete store[key];
          }
        },
      },
      onChanged: { addListener: () => {} },
    },
    alarms: {
      onAlarm: { addListener: () => {} },
      get: async () => undefined,
      clear: async () => {},
      create: () => {},
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          onMessage = listener;
        },
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    webNavigation: {
      onBeforeNavigate: { addListener: () => {} },
    },
  };
  globalThis.fetch = async () =>
    new Response("blocked.example", {
      headers: { "Content-Type": "text/plain" },
    });

  try {
    await import(`../src/background/service_worker.js?test=${Date.now()}`);

    const added = await sendCommand({
      type: "ssb:add-list",
      name: "Test",
      url: "https://example.com/list.txt",
    });
    assert.equal(added.ok, true);
    assert.equal(added.result.ruleCount, 1);
    assert.equal(store.lists.length, 1);
    const listId = store.lists[0].id;

    assert.equal(
      (
        await sendCommand({
          type: "ssb:update-list-enabled",
          listId,
          enabled: false,
        })
      ).ok,
      true,
    );
    assert.equal(store.lists[0].enabled, false);

    assert.equal(
      (
        await sendCommand({
          type: "ssb:update-list-identity",
          listId,
          name: "Renamed",
          url: "https://example.com/renamed.txt",
        })
      ).ok,
      true,
    );
    assert.equal(store.lists[0].name, "Renamed");

    assert.equal(
      (await sendCommand({ type: "ssb:remove-list", listId })).ok,
      true,
    );
    assert.deepEqual(store.lists, []);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }

  function sendCommand(message) {
    return new Promise((resolve) => {
      assert.equal(onMessage(message, {}, resolve), true);
    });
  }
});
