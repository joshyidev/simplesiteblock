import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsExport,
  importSettingsBackup,
  parseSettingsImport,
} from "../src/background/backup.js";
import { rawListStorageKey } from "../src/background/storage.js";

function makeState() {
  return {
    settings: {
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
  assert.deepEqual(payload.lists[0], {
    id: "list-1",
    name: "Hosts",
    url: "https://example.com/hosts.txt",
    format: "hosts",
    enabled: true,
    lastError: null,
    etag: null,
    lastModified: null,
    ruleCount: 0,
  });
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

test("settings import rejects more than 1000 custom domains", () => {
  const customRules = Array.from({ length: 1001 }, (_, i) => `d${i}.example`).join(
    "\n",
  );
  assert.throws(
    () => parseSettingsImport(JSON.stringify(makePayload({ customRules }))),
    /limited to 1000 domains/,
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

test("settings import clears derived list metadata", () => {
  const imported = parseSettingsImport(
    JSON.stringify(
      makePayload({
        lists: [
          {
            id: "list-1",
            name: "List",
            url: "https://example.com/list.txt",
            format: "auto",
            enabled: true,
            lastError: "stale error",
            etag: '"stale"',
            lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
            ruleCount: 123,
          },
        ],
      }),
    ),
  );

  assert.deepEqual(imported.lists[0], {
    id: "list-1",
    name: "List",
    url: "https://example.com/list.txt",
    format: "auto",
    enabled: true,
    lastError: null,
    etag: null,
    lastModified: null,
    ruleCount: 0,
  });
});

test("settings import stores lists and rules and marks pending", async () => {
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
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete store[key];
          }
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

    assert.equal("compiledIndex" in store, false);
    assert.equal(store.customRules, "@@||safe.example^\n||tracker.example^");
    assert.equal(store.lists.length, 1);
    assert.equal(store.lists[0].id, "list-1");
    assert.deepEqual(store.rawLists, {});
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
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete store[key];
          }
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

    assert.equal("compiledIndex" in store, false);
    assert.equal(store.lists.length, 1);
    assert.equal(store.lists[0].url, "https://example.com/hosts.txt");
    assert.equal(store.customRules, "||tracker.example^");
    assert.equal(store.pendingRebuild, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("settings import clears cached raw list bodies", async () => {
  const originalChrome = globalThis.chrome;
  const store = {
    lists: [
      {
        id: "list-1",
        name: "Old",
        url: "https://example.com/old.txt",
        enabled: true,
      },
    ],
    [rawListStorageKey("list-1")]: "0.0.0.0 stale.example",
  };
  const removed = [];
  const payload = makePayload({
    lists: [
      {
        id: "list-1",
        name: "New",
        url: "https://example.com/new.txt",
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
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            removed.push(key);
            delete store[key];
          }
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
    assert.deepEqual(removed, [rawListStorageKey("list-1")]);
    assert.equal(rawListStorageKey("list-1") in store, false);
    assert.equal(store.pendingRebuild, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
