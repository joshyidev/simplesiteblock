import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate,
  hydrateIndex,
  serializeIndex,
} from "../src/background/engine.js";
import {
  addList,
  normalizeListUrl,
  parseCustomRules,
  parseListText,
  reconcileAlarms,
  removeList,
  updateAllLists,
  updateCustomRules,
  updateListSettings,
} from "../src/background/lists.js";
import { parseAdblock } from "../src/background/parser/adblock.js";
import { parseHosts } from "../src/background/parser/hosts.js";

test("hosts parser normalizes hosts, skips comments and local aliases", () => {
  const parsed = parseHosts(`
    # comment
    0.0.0.0 Example.COM localhost
    127.0.0.1 café.example.
    192.168.1.1 router.local
    bad_host
  `);

  assert.equal(parsed.hosts.has("example.com"), true);
  assert.equal(parsed.hosts.has("xn--caf-dma.example"), true);
  assert.equal(parsed.hosts.has("localhost"), false);
  assert.equal(parsed.hosts.has("bad_host"), false);
  assert.equal(parsed.mappingLineCount, 2);
});

test("adblock parser supports host blocks, host allows, regexes, and cosmetic skips", () => {
  const parsed = parseAdblock(`
    ! comment
    ||ads.example.com^
    @@||allowed.example.com^$third-party
    |https://cdn.example.com/ads/*
    /tracker\\d+\\.js/
    example.net/banner
    example.com##.ad
    /[/
  `);

  assert.equal(parsed.hostBlocksSubtree.has("ads.example.com"), true);
  assert.equal(parsed.hostAllowsSubtree.has("allowed.example.com"), true);
  assert.equal(parsed.regexBlocks.length, 3);
  assert.equal(parsed.warnings.length >= 2, true);
});

test("adblock parser supports bare domain lines and hash comments", () => {
  const parsed = parseAdblock(`
    # comment
    example.com
    example.org
    example.net # inline comment
    *.example.test
    example.com##.ad
  `);

  assert.equal(parsed.hostBlocksExact.has("example.com"), true);
  assert.equal(parsed.hostBlocksExact.has("example.org"), true);
  assert.equal(parsed.hostBlocksExact.has("example.net"), true);
  assert.equal(parsed.regexBlocks.length, 1);
  assert.equal(parsed.warnings.length, 1);
});

test("engine applies allow rules before block rules", () => {
  const index = hydrateIndex({
    hostBlocksSubtree: ["example.com"],
    hostAllowsSubtree: ["safe.example.com"],
    regexBlocks: [{ source: "ads", flags: "i" }],
    regexAllows: [{ source: "allowed-path", flags: "i" }],
    builtAt: 1,
  });

  assert.equal(evaluate("https://www.example.com/page", index).blocked, true);
  assert.equal(evaluate("https://safe.example.com/page", index).blocked, false);
  assert.equal(evaluate("https://other.test/ads.js", index).blocked, true);
  assert.equal(
    evaluate("https://other.test/allowed-path/ads.js", index).blocked,
    false,
  );
  assert.equal(evaluate("chrome://extensions", index).blocked, false);
});

test("engine treats exact host rules differently from subtree host rules", () => {
  const exact = hydrateIndex({
    hostBlocksExact: ["example.com"],
    regexBlocks: [],
    regexAllows: [],
    builtAt: 1,
  });
  const subtree = hydrateIndex({
    hostBlocksSubtree: ["example.com"],
    regexBlocks: [],
    regexAllows: [],
    builtAt: 1,
  });

  assert.equal(evaluate("https://example.com/page", exact).blocked, true);
  assert.equal(evaluate("https://www.example.com/page", exact).blocked, false);
  assert.equal(evaluate("https://example.com/page", subtree).blocked, true);
  assert.equal(evaluate("https://www.example.com/page", subtree).blocked, true);
});

test("compiled index can serialize and hydrate", () => {
  const serialized = serializeIndex({
    hostBlocksExact: new Set(["b.example", "a.example"]),
    hostAllowsExact: new Set(["allow.example"]),
    hostBlocksSubtree: new Set(["subtree.example"]),
    hostAllowsSubtree: new Set(["allow-subtree.example"]),
    regexBlocks: [/ads/i],
    regexAllows: [{ source: "safe", flags: "i" }],
    builtAt: 42,
  });
  const hydrated = hydrateIndex(serialized);

  assert.deepEqual(serialized.hostBlocksExact, ["a.example", "b.example"]);
  assert.deepEqual(serialized.hostBlocksSubtree, ["subtree.example"]);
  assert.equal(evaluate("https://b.example", hydrated).blocked, true);
  assert.equal(evaluate("https://x.b.example", hydrated).blocked, false);
  assert.equal(evaluate("https://x.subtree.example", hydrated).blocked, true);
  assert.equal(evaluate("https://x.test/safe-ads.js", hydrated).blocked, false);
});

test("list parser automatically detects hosts or adblock format", () => {
  const hosts = parseListText("0.0.0.0 ads.example\n127.0.0.1 tracker.example");
  const adblock = parseListText("||ads.example^\n@@||safe.example^");
  const domains = parseListText(
    "# comment\nexample.com\nexample.org # comment",
  );

  assert.equal(hosts.detectedFormat, "hosts");
  assert.equal(adblock.detectedFormat, "adblock");
  assert.equal(domains.detectedFormat, "adblock");
  assert.equal(domains.hostBlocksExact.has("example.com"), true);
  assert.equal(domains.hostBlocksExact.has("example.org"), true);
});

test("auto detection keeps StevenBlack-style hosts files as hosts", () => {
  const parsed = parseListText(`
    # Title: StevenBlack/hosts extension fakenews
    # Fetch the latest version of this file: https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-only/hosts
    # Number of unique domains: 2,187
    0.0.0.0 example-fakenews.test
    0.0.0.0 www.example-fakenews.test
  `);

  assert.equal(parsed.detectedFormat, "hosts");
  assert.equal(parsed.hostBlocksExact.has("example-fakenews.test"), true);
  assert.equal(parsed.regexBlocks.length, 0);
});

test("hosts parser output is exact-only after list parsing", () => {
  const parsed = parseListText("0.0.0.0 example.com");
  const index = hydrateIndex(serializeIndex(parsed));

  assert.equal(evaluate("https://example.com", index).blocked, true);
  assert.equal(evaluate("https://www.example.com", index).blocked, false);
});

test("auto detection rejects ordinary web pages and non-list text", () => {
  assert.throws(
    () =>
      parseListText(
        '<!doctype html><html><body><a href="https://ads.brave.com">Advertise</a></body></html>',
      ),
    /web page/,
  );
  assert.throws(
    () => parseListText("Welcome to this website\nPrivacy Policy\nSearch"),
    /valid hosts or Adblock/,
  );
});

test("custom rules parse as Adblock syntax", () => {
  const parsed = parseCustomRules(`
    # comment
    custom-domain.test
    ||custom-block.test^
    @@||custom-allow.test^
    /custom-ad\\d+\\.js/
  `);

  assert.equal(parsed.detectedFormat, "adblock");
  assert.equal(parsed.hostBlocksExact.has("custom-domain.test"), true);
  assert.equal(parsed.hostBlocksSubtree.has("custom-block.test"), true);
  assert.equal(parsed.hostAllowsSubtree.has("custom-allow.test"), true);
  assert.equal(parsed.regexBlocks.length, 1);
});

test("custom rules reject non-Adblock text", () => {
  assert.throws(() => parseCustomRules("hello\nnot a filter"), /valid Adblock/);
});

test("list URLs normalize before duplicate checks", () => {
  assert.equal(
    normalizeListUrl(" HTTPS://Example.COM:443/list.txt "),
    "https://example.com/list.txt",
  );
  assert.throws(() => normalizeListUrl("not a url"), /valid list URL/);
});

test("addList rejects duplicate list URLs before fetching", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;

  globalThis.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return {
            ...defaults,
            lists: [
              {
                id: "existing",
                name: "Existing",
                url: "https://example.com/list.txt",
              },
            ],
          };
        },
        async set() {
          throw new Error("Duplicate list should not write storage.");
        },
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error("Duplicate list should not fetch.");
  };

  try {
    await assert.rejects(
      () => addList({ url: " HTTPS://Example.COM:443/list.txt " }),
      /already been added/,
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

function makeChromeMock({
  lists = [],
  rawLists = {},
  customRules = "",
  settings = {},
} = {}) {
  const store = {
    settings: { updateIntervalDays: 0, ...settings },
    lists,
    rawLists,
    customRules,
    compiledIndex: {
      hostBlocksExact: [],
      hostAllowsExact: [],
      hostBlocksSubtree: [],
      hostAllowsSubtree: [],
      regexBlocks: [],
      regexAllows: [],
      builtAt: 1,
    },
    pendingRebuild: false,
  };
  const written = [];
  return {
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys))
              return Object.fromEntries(keys.map((k) => [k, store[k]]));
            const defaults = typeof keys === "object" ? keys : {};
            return { ...defaults, ...store };
          },
          async set(patch) {
            written.push({ ...patch });
            Object.assign(store, patch);
          },
        },
      },
      alarms: {
        get: async () => undefined,
        clear: async () => {},
        create: () => {},
      },
    },
    written,
    store,
  };
}

test("addList saves list metadata and marks pending without fetching", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const { chrome, written } = makeChromeMock();
  globalThis.chrome = chrome;
  globalThis.fetch = async () => {
    throw new Error("addList should not fetch");
  };

  try {
    await addList({ name: "Test", url: "https://example.com/list.txt" });
    const indexWrite = written.find((w) => "compiledIndex" in w);
    assert.equal(
      indexWrite,
      undefined,
      "compiledIndex should not be recompiled on add",
    );
    const pendingWrite = written.find((w) => "pendingRebuild" in w);
    assert.ok(pendingWrite, "pendingRebuild should be set");
    assert.equal(pendingWrite.pendingRebuild, true);
    const listWrite = written.find((w) => "lists" in w);
    assert.ok(listWrite, "lists should have been saved");
    assert.equal(listWrite.lists.length, 1);
    assert.equal(listWrite.lists[0].url, "https://example.com/list.txt");
    assert.equal(listWrite.lists[0].name, "Test");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("updateAllLists fetches full body when validators exist without cached body", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const { chrome, store } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        format: "auto",
        enabled: true,
        etag: "\"old\"",
        lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
        lastError: null,
        ruleCount: 0,
      },
    ],
    rawLists: {},
  });
  let requestHeaders = null;
  globalThis.chrome = chrome;
  globalThis.fetch = async (_url, options) => {
    requestHeaders = options.headers;
    if (requestHeaders["If-None-Match"] || requestHeaders["If-Modified-Since"]) {
      return new Response("", { status: 304 });
    }
    return new Response("0.0.0.0 ads.example.com", {
      headers: {
        ETag: "\"fresh\"",
        "Last-Modified": "Thu, 02 Jan 2025 00:00:00 GMT",
        "Content-Type": "text/plain",
      },
    });
  };

  try {
    await updateAllLists();
    assert.equal(requestHeaders["If-None-Match"], undefined);
    assert.equal(requestHeaders["If-Modified-Since"], undefined);
    assert.equal(store.rawLists.abc, "0.0.0.0 ads.example.com");
    assert.equal(store.lists[0].etag, "\"fresh\"");
    assert.equal(store.lists[0].lastError, null);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("removeList removes the list and its raw content and marks pending", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        enabled: true,
      },
    ],
    rawLists: { abc: "0.0.0.0 ads.example.com" },
  });
  globalThis.chrome = chrome;

  try {
    await removeList("abc");
    const listWrite = written.find((w) => "lists" in w);
    assert.ok(listWrite, "lists should have been saved");
    assert.equal(listWrite.lists.length, 0);
    const rawWrite = written.find((w) => "rawLists" in w);
    assert.ok(rawWrite, "rawLists should have been saved");
    assert.equal("abc" in rawWrite.rawLists, false);
    const pendingWrite = written.find((w) => "pendingRebuild" in w);
    assert.ok(pendingWrite, "pendingRebuild should have been set");
    assert.equal(pendingWrite.pendingRebuild, true);
    const indexWrite = written.find((w) => "compiledIndex" in w);
    assert.equal(
      indexWrite,
      undefined,
      "compiledIndex should not be recompiled immediately",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateListSettings with enabled change marks pending without recompiling", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        enabled: true,
      },
    ],
  });
  globalThis.chrome = chrome;

  try {
    await updateListSettings("abc", { enabled: false });
    const pendingWrite = written.find((w) => "pendingRebuild" in w);
    assert.ok(pendingWrite, "pendingRebuild should be set");
    assert.equal(pendingWrite.pendingRebuild, true);
    const indexWrite = written.find((w) => "compiledIndex" in w);
    assert.equal(
      indexWrite,
      undefined,
      "compiledIndex should not be recompiled",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateCustomRules validates and saves rules", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written } = makeChromeMock();
  globalThis.chrome = chrome;

  try {
    await updateCustomRules("example.com\n||ads.example.net^");
    const rulesWrite = written.find((w) => "customRules" in w);
    assert.ok(rulesWrite, "customRules should have been saved");
    assert.equal(rulesWrite.customRules, "example.com\n||ads.example.net^");
    const indexWrite = written.find((w) => "compiledIndex" in w);
    assert.ok(indexWrite, "compiledIndex should have been recompiled");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateCustomRules rejects non-Adblock text", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written } = makeChromeMock();
  globalThis.chrome = chrome;

  try {
    await assert.rejects(
      () => updateCustomRules("hello world\nnot a filter"),
      /valid Adblock/,
    );
    assert.equal(
      written.length,
      0,
      "storage should not be written on invalid rules",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileAlarms skips creating alarm when one with correct period exists", async () => {
  const originalChrome = globalThis.chrome;
  const created = [];
  const cleared = [];
  globalThis.chrome = {
    alarms: {
      get: async () => ({ name: "update:index", periodInMinutes: 7 * 1440 }),
      clear: async (name) => {
        cleared.push(name);
      },
      create: (name, opts) => {
        created.push({ name, opts });
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, settings: { updateIntervalDays: 7 } };
        },
      },
    },
  };

  try {
    await reconcileAlarms();
    assert.equal(
      created.length,
      0,
      "alarm should not be recreated when period matches",
    );
    assert.equal(
      cleared.length,
      0,
      "alarm should not be cleared when period matches",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileAlarms clears and recreates alarm when interval changes", async () => {
  const originalChrome = globalThis.chrome;
  const created = [];
  const cleared = [];
  globalThis.chrome = {
    alarms: {
      get: async () => ({ name: "update:index", periodInMinutes: 7 * 1440 }),
      clear: async (name) => {
        cleared.push(name);
      },
      create: (name, opts) => {
        created.push({ name, opts });
      },
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, settings: { updateIntervalDays: 1 } };
        },
      },
    },
  };

  try {
    await reconcileAlarms();
    assert.ok(
      cleared.includes("update:index"),
      "stale alarm should be cleared",
    );
    assert.ok(
      created.some(
        (c) => c.name === "update:index" && c.opts.periodInMinutes === 1440,
      ),
      "alarm should be recreated with new period",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileAlarms clears alarm when interval is set to 0 (manual)", async () => {
  const originalChrome = globalThis.chrome;
  const cleared = [];
  globalThis.chrome = {
    alarms: {
      get: async () => ({ name: "update:index", periodInMinutes: 7 * 1440 }),
      clear: async (name) => {
        cleared.push(name);
      },
      create: () => {},
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, settings: { updateIntervalDays: 0 } };
        },
      },
    },
  };

  try {
    await reconcileAlarms();
    assert.ok(
      cleared.includes("update:index"),
      "alarm should be cleared for manual mode",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});
