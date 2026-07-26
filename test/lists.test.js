import assert from "node:assert/strict";
import test from "node:test";
import {
  addList,
  assertListRedirectBudget,
  handleAlarm,
  normalizeListUrl,
  parseCustomRules,
  parseListText,
  rebuildListRules,
  reconcileAlarms,
  reconcileRules,
  removeList,
  updateAllLists,
  updateCustomRules,
  updateListIdentity,
  updateListSettings,
} from "../src/background/lists.js";
import { rawListStorageKey } from "../src/background/storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

test("list parser automatically detects hosts or adblock format", () => {
  const hosts = parseListText("0.0.0.0 ads.example\n127.0.0.1 tracker.example");
  const adblock = parseListText("||ads.example^\n@@||safe.example^");
  const domains = parseListText(
    "# comment\nexample.com\nexample.org # comment",
  );

  assert.equal(hosts.detectedFormat, "hosts");
  assert.equal(adblock.detectedFormat, "adblock");
  assert.equal(domains.detectedFormat, "adblock");
  assert.equal(domains.block.has("example.com"), true);
  assert.equal(domains.block.has("example.org"), true);
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
  assert.equal(parsed.block.has("example-fakenews.test"), true);
  assert.equal("hostBlocksExact" in parsed, false);
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
  assert.equal(parsed.block.has("custom-domain.test"), true);
  assert.equal(parsed.block.has("custom-block.test"), true);
  assert.equal(parsed.allow.has("custom-allow.test"), true);
  assert.equal("hostBlocksExact" in parsed, false);
  assert.equal(parsed.warnings.length, 1);
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
  dynamicRules = null,
} = {}) {
  const store = {
    settings: { updateIntervalDays: 0, ...settings },
    lists,
    rawLists,
    customRules,
  };
  for (const [listId, text] of Object.entries(rawLists)) {
    store[rawListStorageKey(listId)] = text;
  }
  const written = [];
  const removed = [];
  const result = {
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
    },
    written,
    removed,
    store,
  };

  // Opt-in declarativeNetRequest mock backed by a mutable rule store, so reconcile
  // tests can observe which dynamic rules get added or removed.
  if (dynamicRules) {
    let rules = [...dynamicRules];
    const dnrUpdates = [];
    result.chrome.declarativeNetRequest = {
      getDynamicRules: async () => rules,
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        dnrUpdates.push({ removeRuleIds, addRules });
        rules = rules
          .filter((rule) => !removeRuleIds.includes(rule.id))
          .concat(addRules);
      },
    };
    result.dnrUpdates = dnrUpdates;
    result.getRules = () => rules;
  }

  return result;
}

test("addList fetches, validates, caches, and counts only the new list", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const mock = makeChromeMock({
    lists: [
      {
        id: "existing",
        name: "Existing",
        url: "https://example.com/existing.txt",
        format: "auto",
        enabled: true,
        lastError: null,
        etag: null,
        lastModified: null,
        ruleCount: 1,
      },
    ],
    rawLists: { existing: "existing.example" },
    dynamicRules: [{ id: 1 }],
  });
  globalThis.chrome = mock.chrome;
  const requests = [];
  const body = [
    "||ads.example^",
    "||ads.example^",
    "@@||safe.example^",
    "/unsupported/",
  ].join("\n");
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(body, {
      headers: {
        ETag: '"fresh"',
        "Last-Modified": "Thu, 02 Jan 2025 00:00:00 GMT",
        "Content-Type": "text/plain",
      },
    });
  };

  try {
    const result = await addList({
      name: "Test",
      url: "https://example.com/list.txt",
    });
    const added = mock.store.lists.find((list) => list.id === result.listId);
    assert.deepEqual(requests, ["https://example.com/list.txt"]);
    assert.equal(result.ruleCount, 2);
    assert.equal(result.error, null);
    assert.equal(added.name, "Test");
    assert.equal(added.ruleCount, 2);
    assert.equal(added.lastError, null);
    assert.equal(added.etag, '"fresh"');
    assert.equal(added.lastModified, "Thu, 02 Jan 2025 00:00:00 GMT");
    assert.equal(mock.store[rawListStorageKey(added.id)], body);
    assert.equal(mock.store[rawListStorageKey("existing")], "existing.example");
    // Adding applies the list slice immediately, so the new list blocks now and
    // the pre-existing dynamic rule in the slice's range is replaced.
    assert.equal(mock.dnrUpdates.length, 1);
    assert.deepEqual(mock.dnrUpdates[0].removeRuleIds, [1]);
    const applied = mock
      .getRules()
      .flatMap((rule) => rule.condition.requestDomains);
    assert.deepEqual(applied.sort(), [
      "ads.example",
      "existing.example",
      "safe.example",
    ]);
    const indexWrite = mock.written.find((w) => "compiledIndex" in w);
    assert.equal(
      indexWrite,
      undefined,
      "compiledIndex should not be written on add",
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("addList rejects an invalid download instead of caching it", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const mock = makeChromeMock({ dynamicRules: [] });
  globalThis.chrome = mock.chrome;
  const body = "Welcome to this website\nPrivacy Policy\nSearch";
  const sentHeaders = [];
  globalThis.fetch = async (_url, options) => {
    sentHeaders.push(options.headers);
    return new Response(body, {
      headers: {
        ETag: '"invalid"',
        "Content-Type": "text/plain",
      },
    });
  };

  try {
    const result = await addList({
      name: "Broken",
      url: "https://example.com/not-a-list.txt",
    });
    const added = mock.store.lists[0];
    assert.equal(result.listId, added.id);
    assert.equal(result.ruleCount, null);
    assert.match(result.error, /valid hosts or Adblock/);
    assert.equal(added.ruleCount, 0);
    assert.match(added.lastError, /valid hosts or Adblock/);
    assert.equal(added.etag, null, "a rejected body must not store validators");
    assert.equal(rawListStorageKey(added.id) in mock.store, false);
    // The slice still applies — it just has nothing to contribute.
    assert.equal(mock.store.appliedListDomainCount, 0);

    await updateAllLists();
    // No cached body means no conditional request: the next fetch must be able
    // to pick up a fixed list.
    assert.equal(sentHeaders[1]["If-None-Match"], undefined);
    assert.equal(rawListStorageKey(added.id) in mock.store, false);
    assert.match(mock.store.lists[0].lastError, /valid hosts or Adblock/);
    assert.equal(mock.store.appliedListDomainCount, 0);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("a list that starts serving junk keeps its last known-good body", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const goodBody = "0.0.0.0 ads.example\n0.0.0.0 tracker.example";
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Good list",
        url: "https://example.com/list.txt",
        format: "auto",
        enabled: true,
        lastError: null,
        etag: '"good"',
        lastModified: null,
        ruleCount: 2,
      },
    ],
    rawLists: { abc: goodBody },
    dynamicRules: [],
  });
  globalThis.chrome = mock.chrome;
  globalThis.fetch = async () =>
    new Response("<!doctype html><html><body>Account suspended</body></html>", {
      headers: { ETag: '"junk"', "Content-Type": "text/plain" },
    });

  try {
    await updateAllLists();

    const list = mock.store.lists[0];
    assert.equal(
      mock.store[rawListStorageKey("abc")],
      goodBody,
      "the junk download must not overwrite the cached body",
    );
    assert.match(list.lastError, /web page/);
    assert.equal(list.etag, '"good"', "validators must still match the body");
    assert.equal(list.ruleCount, 2);

    // The rebuild still applies the good body, so blocking never lapses.
    const domains = mock
      .getRules()
      .filter((rule) => rule.id < 1_000_000)
      .flatMap((rule) => rule.condition.requestDomains);
    assert.deepEqual(domains.sort(), ["ads.example", "tracker.example"]);
    assert.equal(mock.store.appliedListDomainCount, 2);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("addList records a network failure and caches no body", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const mock = makeChromeMock({ dynamicRules: [] });
  globalThis.chrome = mock.chrome;
  globalThis.fetch = async () => {
    throw new Error("Network unavailable");
  };

  try {
    const result = await addList({
      name: "Offline",
      url: "https://example.com/offline.txt",
    });
    const added = mock.store.lists[0];
    assert.equal(result.listId, added.id);
    assert.equal(result.ruleCount, null);
    assert.equal(result.error, "Network unavailable");
    assert.equal(added.lastError, "Network unavailable");
    assert.equal(rawListStorageKey(added.id) in mock.store, false);
    assert.equal(mock.store.appliedListDomainCount, 0);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("updateListIdentity changes name without clearing cached list body", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written, store } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Old name",
        url: "https://example.com/list.txt",
        enabled: true,
        etag: '"old"',
        lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
        lastError: "previous error",
        ruleCount: 12,
      },
    ],
    rawLists: { abc: "0.0.0.0 ads.example" },
  });
  globalThis.chrome = chrome;

  try {
    await updateListIdentity("abc", {
      name: "New name",
      url: " https://example.com/list.txt ",
    });

    assert.equal(store.lists[0].name, "New name");
    assert.equal(store.lists[0].url, "https://example.com/list.txt");
    assert.equal(store.lists[0].etag, '"old"');
    assert.equal(store.lists[0].lastModified, "Wed, 01 Jan 2025 00:00:00 GMT");
    assert.equal(store.lists[0].lastError, "previous error");
    assert.equal(store.lists[0].ruleCount, 12);
    assert.equal(store[rawListStorageKey("abc")], "0.0.0.0 ads.example");
    assert.equal(
      written.some((w) => "rawLists" in w),
      false,
    );
    assert.equal(
      written.some((w) => "guardCacheVersion" in w),
      false,
      "a name-only edit changes no rules, so it must not reapply the slice",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateListIdentity changes URL, clears cached body, and reapplies rules", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, removed, store, written } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Old name",
        url: "https://example.com/list.txt",
        enabled: true,
        etag: '"old"',
        lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
        lastError: "previous error",
        ruleCount: 12,
      },
    ],
    rawLists: { abc: "0.0.0.0 ads.example" },
  });
  globalThis.chrome = chrome;

  try {
    await updateListIdentity("abc", {
      name: " ",
      url: " HTTPS://Example.ORG/new-list.txt ",
    });

    assert.equal(store.lists[0].name, "example.org");
    assert.equal(store.lists[0].url, "https://example.org/new-list.txt");
    assert.equal(store.lists[0].etag, null);
    assert.equal(store.lists[0].lastModified, null);
    assert.equal(store.lists[0].lastError, null);
    assert.equal(store.lists[0].ruleCount, 0);
    assert.equal(rawListStorageKey("abc") in store, false);
    assert.deepEqual(removed, [rawListStorageKey("abc")]);
    // Repointing drops the old body, so the old domains stop blocking at once.
    const sliceWrite = written.find((w) => "guardHostsList" in w);
    assert.ok(sliceWrite, "the list slice should have been reapplied");
    assert.deepEqual(sliceWrite.guardHostsList.block, []);
    assert.equal(store.appliedListDomainCount, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateListIdentity rejects duplicate and invalid URLs", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "One",
        url: "https://example.com/one.txt",
        enabled: true,
      },
      {
        id: "def",
        name: "Two",
        url: "https://example.com/two.txt",
        enabled: true,
      },
    ],
  });
  globalThis.chrome = chrome;

  try {
    await assert.rejects(
      () =>
        updateListIdentity("abc", {
          name: "Duplicate",
          url: "https://example.com/two.txt",
        }),
      /already been added/,
    );
    await assert.rejects(
      () =>
        updateListIdentity("abc", {
          name: "Broken",
          url: "not a url",
        }),
      /valid list URL/,
    );
    await assert.rejects(
      () =>
        updateListIdentity("missing", {
          name: "Missing",
          url: "https://example.com/three.txt",
        }),
      /List not found/,
    );
    assert.equal(written.length, 0, "invalid edits should not write storage");
  } finally {
    globalThis.chrome = originalChrome;
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
        etag: '"old"',
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
    if (
      requestHeaders["If-None-Match"] ||
      requestHeaders["If-Modified-Since"]
    ) {
      return new Response("", { status: 304 });
    }
    return new Response("0.0.0.0 ads.example.com", {
      headers: {
        ETag: '"fresh"',
        "Last-Modified": "Thu, 02 Jan 2025 00:00:00 GMT",
        "Content-Type": "text/plain",
      },
    });
  };

  try {
    await updateAllLists();
    assert.equal(requestHeaders["If-None-Match"], undefined);
    assert.equal(requestHeaders["If-Modified-Since"], undefined);
    assert.equal(store[rawListStorageKey("abc")], "0.0.0.0 ads.example.com");
    assert.equal(store.lists[0].etag, '"fresh"');
    assert.equal(store.lists[0].lastError, null);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("updateAllLists records attempt and completion timestamps", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const { chrome, store } = makeChromeMock();
  let now = 1000;
  globalThis.chrome = chrome;
  Date.now = () => now++;

  try {
    await updateAllLists();
    assert.equal(store.lastListUpdateAttemptAt, 1000);
    assert.ok(
      store.lastListUpdateCompletedAt > store.lastListUpdateAttemptAt,
      "completion should be recorded after the attempt begins",
    );
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("updateAllLists records a completed check when rule rebuilding fails", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({ dynamicRules: [] });
  mock.chrome.declarativeNetRequest.updateDynamicRules = async () => {
    throw new Error("DNR update failed");
  };
  globalThis.chrome = mock.chrome;

  try {
    await assert.rejects(() => updateAllLists(), /DNR update failed/);
    assert.ok(mock.store.lastListUpdateAttemptAt);
    assert.ok(
      mock.store.lastListUpdateCompletedAt >=
        mock.store.lastListUpdateAttemptAt,
      "fetch completion should survive a later rule-application failure",
    );
    assert.equal(mock.store.lastListBuildError, "DNR update failed");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("an alarm-driven rule build failure is recorded, then cleared", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({ dynamicRules: [] });
  let failApply = true;
  const realUpdate = mock.chrome.declarativeNetRequest.updateDynamicRules;
  mock.chrome.declarativeNetRequest.updateDynamicRules = async (patch) => {
    if (failApply) throw new Error("DNR update failed");
    return realUpdate(patch);
  };
  globalThis.chrome = mock.chrome;

  try {
    // handleAlarm swallows the error, so storage is the only channel left.
    await handleAlarm({ name: "update:index" });
    assert.equal(mock.store.lastListBuildError, "DNR update failed");

    failApply = false;
    await updateAllLists();
    assert.equal(
      mock.store.lastListBuildError,
      null,
      "a successful build must clear the recorded error",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules with nothing to rebuild keeps a standing build error", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({ dynamicRules: [] });
  mock.store.lastListBuildError = "Over the rule limit";
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    assert.equal(
      mock.store.lastListBuildError,
      "Over the rule limit",
      "a no-op reconcile must not clear an error it did not resolve",
    );
    assert.deepEqual(mock.dnrUpdates, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconciling one slice preserves a standing error on the other", async () => {
  const originalChrome = globalThis.chrome;
  // Orphaned custom rules with no backing text: reconciliation rebuilds the
  // custom slice only, and must not touch the list slice's recorded failure.
  const mock = makeChromeMock({
    customRules: "",
    dynamicRules: [{ id: 1_000_001 }],
  });
  mock.store.lastListBuildError = "Over the rule limit";
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();

    assert.equal(
      mock.store.lastCustomBuildError,
      null,
      "the rebuilt slice clears its own error",
    );
    assert.equal(
      mock.store.lastListBuildError,
      "Over the rule limit",
      "the list slice was never retried, so its warning must survive",
    );
    assert.deepEqual(
      mock.getRules(),
      [],
      "the orphaned custom rule should have been cleared",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateAllLists reports what each list actually did", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const mock = makeChromeMock({
    lists: [
      {
        id: "fresh",
        name: "Fresh",
        url: "https://example.com/fresh.txt",
        format: "auto",
        enabled: true,
        etag: null,
        lastModified: null,
        ruleCount: 0,
      },
      {
        id: "cached",
        name: "Cached",
        url: "https://example.com/cached.txt",
        format: "auto",
        enabled: true,
        etag: '"cached"',
        lastModified: null,
        ruleCount: 1,
      },
      {
        id: "broken",
        name: "Broken",
        url: "https://example.com/broken.txt",
        format: "auto",
        enabled: true,
        etag: null,
        lastModified: null,
        ruleCount: 0,
      },
      {
        id: "off",
        name: "Disabled",
        url: "https://example.com/off.txt",
        format: "auto",
        enabled: false,
      },
    ],
    rawLists: { cached: "0.0.0.0 cached.example" },
    dynamicRules: [],
  });
  globalThis.chrome = mock.chrome;
  globalThis.fetch = async (url) => {
    if (url.includes("broken")) throw new Error("Network unavailable");
    if (url.includes("cached")) return new Response(null, { status: 304 });
    return new Response("0.0.0.0 fresh.example", {
      headers: { "Content-Type": "text/plain" },
    });
  };

  try {
    const summary = await updateAllLists();
    assert.deepEqual(summary, {
      checked: 3,
      updated: 1,
      unchanged: 1,
      failed: 1,
    });
    assert.equal(mock.store.lastListBuildError, null);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("concurrent updateAllLists calls share one in-flight update", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const { chrome, written } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/list.txt",
        enabled: true,
      },
    ],
  });
  let fetchCalls = 0;
  let resolveFetch;
  let markFetchStarted;
  const fetchReleased = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  globalThis.chrome = chrome;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    markFetchStarted();
    await fetchReleased;
    return new Response("0.0.0.0 example.com", {
      headers: { "Content-Type": "text/plain" },
    });
  };

  try {
    const first = updateAllLists();
    const second = updateAllLists();
    await fetchStarted;
    assert.equal(fetchCalls, 1);
    resolveFetch();
    await Promise.all([first, second]);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("addList waits for Update All without being lost to its snapshot", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const { chrome, store } = makeChromeMock({
    lists: [
      {
        id: "existing",
        name: "Existing",
        url: "https://example.com/existing.txt",
        format: "auto",
        enabled: true,
        lastError: null,
        etag: null,
        lastModified: null,
        ruleCount: 1,
      },
    ],
    rawLists: { existing: "existing.example" },
  });
  let releaseUpdate;
  let markUpdateStarted;
  const updateReleased = new Promise((resolve) => {
    releaseUpdate = resolve;
  });
  const updateStarted = new Promise((resolve) => {
    markUpdateStarted = resolve;
  });
  const requests = [];

  globalThis.chrome = chrome;
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/existing.txt")) {
      markUpdateStarted();
      await updateReleased;
      return new Response("existing.example", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("new.example", {
      headers: { "Content-Type": "text/plain" },
    });
  };

  try {
    const update = updateAllLists();
    await updateStarted;
    const add = addList({
      name: "New",
      url: "https://example.com/new.txt",
    });
    await Promise.resolve();
    assert.deepEqual(requests, ["https://example.com/existing.txt"]);

    releaseUpdate();
    const [, result] = await Promise.all([update, add]);
    assert.equal(result.ruleCount, 1);
    assert.deepEqual(
      store.lists.map((list) => list.name),
      ["Existing", "New"],
    );
    assert.equal(store[rawListStorageKey("existing")], "existing.example");
    assert.equal(
      store[rawListStorageKey(result.listId)],
      "new.example",
    );
    assert.equal(
      store.appliedListDomainCount,
      2,
      "both the updated and the newly added list end up applied",
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("removeList waits for Update All and removes its cached body", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const { chrome, store } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/list.txt",
        format: "auto",
        enabled: true,
        lastError: null,
        etag: null,
        lastModified: null,
        ruleCount: 0,
      },
    ],
  });
  let releaseFetch;
  let markFetchStarted;
  const fetchReleased = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  globalThis.chrome = chrome;
  globalThis.fetch = async () => {
    markFetchStarted();
    await fetchReleased;
    return new Response("blocked.example", {
      headers: { "Content-Type": "text/plain" },
    });
  };

  try {
    const update = updateAllLists();
    await fetchStarted;
    const removal = removeList("abc");
    releaseFetch();
    await Promise.all([update, removal]);

    assert.deepEqual(store.lists, []);
    assert.equal(rawListStorageKey("abc") in store, false);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("removeList removes the list and its raw content and marks pending", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, removed, written } = makeChromeMock({
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
    assert.deepEqual(removed, [rawListStorageKey("abc")]);
    const sliceWrite = written.find((w) => "guardHostsList" in w);
    assert.ok(sliceWrite, "removing a list must reapply the slice");
    assert.deepEqual(
      sliceWrite.guardHostsList.block,
      [],
      "a removed list stops blocking immediately",
    );
    const indexWrite = written.find((w) => "compiledIndex" in w);
    assert.equal(indexWrite, undefined, "compiledIndex is a v1 artifact");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("disabling a list stops it blocking immediately", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        format: "auto",
        enabled: true,
      },
    ],
    rawLists: { abc: "0.0.0.0 ads.example.com" },
    dynamicRules: [],
  });
  const { chrome, store } = mock;
  globalThis.chrome = chrome;

  const appliedDomains = () =>
    mock.getRules().flatMap((rule) => rule.condition.requestDomains);

  try {
    // Establish the applied baseline: list enabled with a cached body.
    await rebuildListRules();
    assert.deepEqual(appliedDomains(), ["ads.example.com"]);

    await updateListSettings("abc", { enabled: false });
    assert.deepEqual(
      appliedDomains(),
      [],
      "a disabled list must stop blocking without waiting for Update All",
    );
    assert.equal(store.appliedListDomainCount, 0);

    await updateListSettings("abc", { enabled: true });
    assert.deepEqual(
      appliedDomains(),
      ["ads.example.com"],
      "re-enabling restores blocking from the cached body",
    );
    assert.equal(store.appliedListDomainCount, 1);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("rebuildListRules persists guard host sets for the navigation guard", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, store } = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        format: "auto",
        enabled: true,
      },
    ],
    rawLists: { abc: "||ads.example.com^\n@@good.example.com" },
  });
  globalThis.chrome = chrome;

  try {
    await rebuildListRules();
    assert.deepEqual(store.guardHostsList, {
      block: ["ads.example.com"],
      allow: ["good.example.com"],
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateCustomRules persists guard host sets for the navigation guard", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, store } = makeChromeMock();
  globalThis.chrome = chrome;

  try {
    await updateCustomRules("blocked.example.com\n@@allowed.example.com");
    assert.deepEqual(store.guardHostsCustom, {
      block: ["blocked.example.com"],
      allow: ["allowed.example.com"],
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateCustomRules validates and saves rules", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, store, written } = makeChromeMock();
  store.lastCustomBuildError = "Previous custom build failed";
  globalThis.chrome = chrome;

  try {
    await updateCustomRules("example.com\n||ads.example.net^");
    const rulesWrite = written.find((w) => "customRules" in w);
    assert.ok(rulesWrite, "customRules should have been saved");
    assert.equal(rulesWrite.customRules, "example.com\n||ads.example.net^");
    // Custom rules apply to their own slice and never touch the list slice.
    const listWrite = written.find((w) => "guardHostsList" in w);
    assert.equal(listWrite, undefined, "custom rules must not rebuild lists");
    const statsWrite = written.find((w) => "appliedCustomDomainCount" in w);
    assert.ok(statsWrite, "custom rule stats should be written");
    assert.equal(statsWrite.appliedCustomDomainCount, 2);
    assert.equal(
      store.lastCustomBuildError,
      null,
      "a successful custom build must clear its standing error",
    );
    assert.equal(
      written.some(
        (write) =>
          "lastListUpdateAttemptAt" in write ||
          "lastListUpdateCompletedAt" in write,
      ),
      false,
      "custom rules must not postpone subscribed-list updates",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("each applied slice commits its derived state in one write", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/list.txt",
        format: "auto",
        enabled: true,
      },
    ],
    customRules: "||custom.example^",
    dynamicRules: [],
  });
  globalThis.chrome = mock.chrome;
  globalThis.fetch = async () =>
    new Response("0.0.0.0 ads.example", {
      headers: { "Content-Type": "text/plain" },
    });

  try {
    await updateAllLists();

    // The guard's host sets must land in the same write as the cache version and
    // the counts derived from them, so a worker death cannot separate them.
    const listWrite = mock.written.find((write) => "guardHostsList" in write);
    assert.deepEqual(Object.keys(listWrite).sort(), [
      "appliedListDomainCount",
      "appliedListRuleCount",
      "guardCacheVersion",
      "guardHostsList",
    ]);
    assert.deepEqual(listWrite.guardHostsList.block, ["ads.example"]);

    const customWrite = mock.written.find(
      (write) => "guardHostsCustom" in write,
    );
    assert.deepEqual(Object.keys(customWrite).sort(), [
      "appliedCustomDomainCount",
      "appliedCustomRuleCount",
      "guardCacheVersion",
      "guardHostsCustom",
    ]);
    assert.deepEqual(customWrite.guardHostsCustom.block, ["custom.example"]);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("each applied slice gets a fresh, independent guard cache version", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/list.txt",
        format: "auto",
        enabled: true,
      },
    ],
    customRules: "||custom.example^",
    dynamicRules: [],
  });
  globalThis.chrome = mock.chrome;
  globalThis.fetch = async () =>
    new Response("0.0.0.0 ads.example", {
      headers: { "Content-Type": "text/plain" },
    });

  try {
    await updateAllLists();

    // Both slices apply back to back. A wall-clock stamp could give them the
    // same value, and a read-modify-write counter could collide with the
    // incognito worker, which has its own queue over the same storage. Either
    // way the guard would keep caching the first slice's hosts.
    const versions = mock.written
      .filter((write) => "guardCacheVersion" in write)
      .map((write) => write.guardCacheVersion);
    assert.equal(versions.length, 2);
    assert.equal(
      new Set(versions).size,
      2,
      "each applied slice needs a distinct cache version",
    );
    for (const version of versions) {
      assert.equal(typeof version, "string");
      assert.ok(version.length > 0);
    }
    assert.equal(mock.store.guardCacheVersion, versions[1]);

    // Nothing derives the next version from the stored one, so two workers
    // committing concurrently cannot land on the same token.
    await rebuildListRules();
    assert.equal(
      versions.includes(mock.store.guardCacheVersion),
      false,
      "a later build must not reuse an earlier token",
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("assertListRedirectBudget throws past the unsafe-rule cap", () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({ dynamicRules: [] });
  globalThis.chrome = mock.chrome;

  try {
    // No cap declared by the runtime: falls back to 5,000 less the reserve.
    assert.doesNotThrow(() => assertListRedirectBudget(0));
    assert.doesNotThrow(() => assertListRedirectBudget(4000));
    assert.throws(() => assertListRedirectBudget(10000), /rule limit/);

    // A runtime that declares its own cap wins over the fallback.
    mock.chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 100;
    assert.doesNotThrow(() => assertListRedirectBudget(80));
    assert.throws(() => assertListRedirectBudget(200), /rule limit/);

    mock.chrome.declarativeNetRequest.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 20000;
    assert.doesNotThrow(() => assertListRedirectBudget(10000));
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("updateCustomRules rejects more than 1000 domains", async () => {
  const originalChrome = globalThis.chrome;
  const { chrome, written } = makeChromeMock();
  globalThis.chrome = chrome;
  const rules = Array.from({ length: 1001 }, (_, i) => `d${i}.example`).join(
    "\n",
  );

  try {
    await assert.rejects(
      () => updateCustomRules(rules),
      /limited to 1000 domains/,
    );
    assert.equal(written.length, 0, "nothing is saved when over the limit");
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

function makeAlarmChrome({ existing, intervalDays, lastAttemptAt = 0 }) {
  const created = [];
  const cleared = [];
  return {
    chrome: {
      alarms: {
        get: async () => existing,
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
            return {
              ...defaults,
              settings: { updateIntervalDays: intervalDays },
              lastListUpdateAttemptAt: lastAttemptAt,
            };
          },
        },
      },
    },
    created,
    cleared,
  };
}

test("reconcileAlarms keeps an alarm anchored to the last update", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  const lastAttemptAt = now;
  const mock = makeAlarmChrome({
    existing: {
      name: "update:index",
      periodInMinutes: 7 * 1440,
      scheduledTime: lastAttemptAt + 7 * DAY_MS,
    },
    intervalDays: 7,
    lastAttemptAt,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    assert.equal(
      mock.created.length,
      0,
      "an accurately scheduled alarm should be preserved",
    );
    assert.equal(
      mock.cleared.length,
      0,
      "an accurately scheduled alarm should not be cleared",
    );
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("reconcileAlarms clears and recreates alarm when interval changes", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  const mock = makeAlarmChrome({
    existing: {
      name: "update:index",
      periodInMinutes: 7 * 1440,
      scheduledTime: now + 7 * DAY_MS,
    },
    intervalDays: 1,
    lastAttemptAt: now,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    assert.ok(
      mock.cleared.includes("update:index"),
      "stale alarm should be cleared",
    );
    assert.deepEqual(mock.created, [
      {
        name: "update:index",
        opts: {
          when: now + DAY_MS,
          periodInMinutes: 1440,
        },
      },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("reconcileAlarms preserves the remaining delay after alarm loss", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  const mock = makeAlarmChrome({
    existing: undefined,
    intervalDays: 3,
    lastAttemptAt: now - DAY_MS,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    assert.deepEqual(mock.created, [
      {
        name: "update:index",
        opts: {
          when: now + 2 * DAY_MS,
          periodInMinutes: 3 * 1440,
        },
      },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("reconcileAlarms schedules an overdue update after the minimum delay", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  const mock = makeAlarmChrome({
    existing: undefined,
    intervalDays: 3,
    lastAttemptAt: now - 5 * DAY_MS,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    assert.deepEqual(mock.created, [
      {
        name: "update:index",
        opts: {
          when: now + MINUTE_MS,
          periodInMinutes: 3 * 1440,
        },
      },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("reconcileAlarms treats an unset attempt time as promptly due", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  const mock = makeAlarmChrome({
    existing: undefined,
    intervalDays: 3,
    lastAttemptAt: 0,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    assert.deepEqual(mock.created, [
      {
        name: "update:index",
        opts: {
          when: now + MINUTE_MS,
          periodInMinutes: 3 * 1440,
        },
      },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("reconcileAlarms preserves a pending overdue alarm across worker wakes", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  const mock = makeAlarmChrome({
    existing: {
      name: "update:index",
      periodInMinutes: 3 * 1440,
      scheduledTime: now - 3 * 60 * MINUTE_MS,
    },
    intervalDays: 3,
    lastAttemptAt: now - 5 * DAY_MS,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    now += 2 * 60 * MINUTE_MS;
    await reconcileAlarms();
    assert.deepEqual(mock.cleared, []);
    assert.deepEqual(mock.created, []);
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("reconcileAlarms corrects a same-period alarm postponed by reload", async () => {
  const originalChrome = globalThis.chrome;
  const originalNow = Date.now;
  const now = 1_700_000_000_000;
  const mock = makeAlarmChrome({
    existing: {
      name: "update:index",
      periodInMinutes: 3 * 1440,
      scheduledTime: now + 3 * DAY_MS,
    },
    intervalDays: 3,
    lastAttemptAt: now - 5 * DAY_MS,
  });
  globalThis.chrome = mock.chrome;
  Date.now = () => now;

  try {
    await reconcileAlarms();
    assert.deepEqual(mock.cleared, ["update:index"]);
    assert.equal(mock.created[0].opts.when, now + MINUTE_MS);
  } finally {
    globalThis.chrome = originalChrome;
    Date.now = originalNow;
  }
});

test("handleAlarm anchors the cadence when the update records no attempt", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock();
  const storageSet = mock.chrome.storage.local.set;
  let failAttemptWrite = true;
  mock.chrome.storage.local.set = async (patch) => {
    if (failAttemptWrite && "lastListUpdateAttemptAt" in patch) {
      failAttemptWrite = false;
      throw new Error("storage unavailable");
    }
    return storageSet(patch);
  };
  globalThis.chrome = mock.chrome;
  const firedAt = Date.now();

  try {
    await handleAlarm({ name: "update:index" });
    assert.ok(
      mock.store.lastListUpdateAttemptAt >= firedAt,
      "a failed update must still advance the anchor, or reconcileAlarms re-arms every minute",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("handleAlarm does not re-anchor a successful update", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock();
  globalThis.chrome = mock.chrome;

  try {
    await handleAlarm({ name: "update:index" });
    const attemptWrites = mock.written.filter(
      (write) => "lastListUpdateAttemptAt" in write,
    );
    assert.equal(
      attemptWrites.length,
      1,
      "the update's own attempt record should be left alone",
    );
    assert.ok(mock.store.lastListUpdateCompletedAt);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules clears orphaned list rules inherited from a prior install", async () => {
  const originalChrome = globalThis.chrome;
  // Fresh storage (no lists, empty applied signature) but the browser still has
  // list rules plus a legitimate custom rule from before a reset/reinstall.
  const mock = makeChromeMock({
    customRules: "example.com",
    dynamicRules: [{ id: 1 }, { id: 2 }, { id: 1000000 }],
  });
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    // The orphaned list-slice rules (ids 1, 2) are cleared; the custom rule stays.
    assert.deepEqual(
      mock.getRules().map((r) => r.id),
      [1000000],
    );
    assert.equal(mock.dnrUpdates.length, 1, "only the list slice is rebuilt");
    assert.deepEqual(mock.dnrUpdates[0].removeRuleIds, [1, 2]);
    assert.deepEqual(mock.dnrUpdates[0].addRules, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules clears orphaned custom rules when there is no custom text", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({ dynamicRules: [{ id: 1000000 }] });
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    assert.deepEqual(mock.getRules(), []);
    assert.equal(mock.dnrUpdates.length, 1, "only the custom slice is rebuilt");
    assert.deepEqual(mock.dnrUpdates[0].removeRuleIds, [1000000]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules leaves a healthy applied state untouched", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        format: "auto",
        enabled: true,
      },
    ],
    rawLists: { abc: "0.0.0.0 ads.example.com" },
    customRules: "keep.example",
    dynamicRules: [{ id: 2 }, { id: 1000000 }],
  });
  mock.store.appliedListDomainCount = 1;
  mock.store.appliedListRuleCount = 1;
  mock.store.appliedCustomDomainCount = 1;
  mock.store.appliedCustomRuleCount = 1;
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    assert.equal(mock.dnrUpdates.length, 0, "no slice should be rebuilt");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules clears list rules left by a config that now enables none", async () => {
  const originalChrome = globalThis.chrome;
  // A disabled list with rules still applied can no longer happen through normal
  // operation — disabling reapplies the slice — so treat it as orphan drift.
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        format: "auto",
        enabled: false,
      },
    ],
    dynamicRules: [{ id: 2 }],
  });
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    assert.deepEqual(mock.getRules(), [], "stale list rules must be cleared");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules restores list rules that vanished though some were applied", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChromeMock({
    lists: [
      {
        id: "abc",
        name: "Test",
        url: "https://example.com/l.txt",
        format: "auto",
        enabled: true,
      },
    ],
    rawLists: { abc: "0.0.0.0 ads.example.com" },
    dynamicRules: [],
  });
  mock.store.appliedListRuleCount = 1;
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    const listRules = mock
      .getRules()
      .filter((r) => r.id >= 1 && r.id < 1000000);
    assert.equal(listRules.length, 1, "the list slice is repopulated");
    assert.equal(listRules[0].action.type, "redirect");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileRules restores an allow-only custom slice that vanished", async () => {
  const originalChrome = globalThis.chrome;
  // An allow-only ruleset applies a DNR allow rule but blocks 0 domains, so the
  // block-domain count is 0; reconcile must still restore it from the rule count.
  const mock = makeChromeMock({
    customRules: "@@allowed.example.com",
    dynamicRules: [],
  });
  mock.store.appliedCustomDomainCount = 0;
  mock.store.appliedCustomRuleCount = 1;
  globalThis.chrome = mock.chrome;

  try {
    await reconcileRules();
    const customRules = mock.getRules().filter((r) => r.id >= 1000000);
    assert.equal(customRules.length, 1, "the custom slice is repopulated");
    assert.equal(customRules[0].action.type, "allow");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("reconcileAlarms clears alarm when interval is set to 0 (manual)", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeAlarmChrome({
    existing: { name: "update:index", periodInMinutes: 7 * 1440 },
    intervalDays: 0,
  });
  globalThis.chrome = mock.chrome;

  try {
    await reconcileAlarms();
    assert.ok(
      mock.cleared.includes("update:index"),
      "alarm should be cleared for manual mode",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});
