import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsExport,
  importSettingsBackup,
  parseSettingsImport,
} from "../src/background/backup.js";
import { evaluate, hydrateIndex } from "../src/background/engine.js";

function makeState() {
  return {
    settings: {
      blockAction: "show_block_page",
      updateIntervalDays: 7,
      passwordEnabled: true,
      password: "accountability",
    },
    lists: [
      {
        id: "list-1",
        name: "Hosts",
        url: "https://example.com/hosts.txt",
        format: "hosts",
        enabled: true,
        lastError: null,
        etag: null,
        lastModified: null,
        ruleCount: 1,
      },
    ],
    rawLists: {
      "list-1": "0.0.0.0 ads.example",
    },
    customRules: "||tracker.example^",
    compiledIndex: {
      hostBlocksExact: ["should-not-export.example"],
      builtAt: 1,
    },
    pendingRebuild: true,
  };
}

function makePayload(overrides = {}) {
  return {
    app: "SimpleSiteBlock",
    version: 1,
    settings: {
      blockAction: "show_block_page",
      updateIntervalDays: 7,
    },
    lists: [],
    rawLists: {},
    customRules: "",
    ...overrides,
  };
}

test("settings export omits derived and cached data by default", () => {
  const payload = JSON.parse(createSettingsExport(makeState()));

  assert.equal("compiledIndex" in payload, false);
  assert.equal("pendingRebuild" in payload, false);
  assert.equal("rawLists" in payload, false);
  assert.equal("password" in payload, false);
  assert.equal("password" in payload.settings, false);
});

test("settings export includes password settings only when requested", () => {
  const payload = JSON.parse(
    createSettingsExport(makeState(), { includePassword: true }),
  );

  assert.deepEqual(payload.password, {
    passwordEnabled: true,
    password: "accountability",
  });
});

test("settings import accepts plaintext password settings", () => {
  const imported = parseSettingsImport(
    JSON.stringify(
      makePayload({
        password: {
          passwordEnabled: true,
          password: "accountability",
        },
      }),
    ),
  );

  assert.equal(imported.settings.passwordEnabled, true);
  assert.equal(imported.settings.password, "accountability");
});

test("settings import rejects compiled indexes", () => {
  assert.throws(
    () =>
      parseSettingsImport(
        JSON.stringify(makePayload({ compiledIndex: { hostBlocksExact: [] } })),
      ),
    /compiled index/,
  );
});

test("settings import rejects invalid custom rules", () => {
  assert.throws(
    () =>
      parseSettingsImport(
        JSON.stringify(makePayload({ customRules: "hello\nnot a filter" })),
      ),
    /valid Adblock/,
  );
});

test("settings import ignores raw list bodies", () => {
  const imported = parseSettingsImport(
    JSON.stringify(
      makePayload({
        rawLists: { "list-1": "not a hosts file" },
        lists: [
          {
            id: "list-1",
            name: "List",
            url: "https://example.com/list.txt",
            format: "auto",
            enabled: true,
          },
        ],
      }),
    ),
  );

  assert.deepEqual(imported.rawLists, {});
  assert.equal(imported.lists.length, 1);
});

test("settings import rebuilds compiled index from custom rules", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  const payload = makePayload({
    lists: [
      {
        id: "list-1",
        name: "Hosts",
        url: "https://example.com/hosts.txt",
        format: "hosts",
        enabled: true,
      },
    ],
    rawLists: { "list-1": "0.0.0.0 ads.example" },
    customRules: "@@||safe.example^\n||tracker.example^",
  });

  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...store };
        },
        async set(patch) {
          Object.assign(store, patch);
        },
      },
    },
    alarms: {
      get: async () => undefined,
      clear: async () => {},
      create: () => {},
    },
  };

  try {
    await importSettingsBackup(JSON.stringify(payload));
    const index = hydrateIndex(store.compiledIndex);

    assert.equal("compiledIndex" in payload, false);
    assert.equal(evaluate("https://ads.example", index).blocked, false);
    assert.equal(
      evaluate("https://cdn.tracker.example/app.js", index).blocked,
      true,
    );
    assert.equal(evaluate("https://safe.example", index).blocked, false);
    assert.equal(store.pendingRebuild, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("settings import marks URL-only lists pending", async () => {
  const originalChrome = globalThis.chrome;
  const store = {};
  const payload = makePayload({
    lists: [
      {
        id: "list-1",
        name: "Hosts",
        url: "https://example.com/hosts.txt",
        format: "hosts",
        enabled: true,
      },
    ],
    customRules: "||tracker.example^",
  });

  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...store };
        },
        async set(patch) {
          Object.assign(store, patch);
        },
      },
    },
    alarms: {
      get: async () => undefined,
      clear: async () => {},
      create: () => {},
    },
  };

  try {
    await importSettingsBackup(JSON.stringify(payload));
    const index = hydrateIndex(store.compiledIndex);

    assert.equal(
      evaluate("https://cdn.tracker.example/app.js", index).blocked,
      true,
    );
    assert.equal(evaluate("https://ads.example", index).blocked, false);
    assert.equal(store.pendingRebuild, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
