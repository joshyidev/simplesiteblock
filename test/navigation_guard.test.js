import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMatcher,
  guardNavigation,
  registerNavigationGuard,
} from "../src/background/navigation_guard.js";

function makeChrome({
  listBlock = [],
  listAllow = [],
  customBlock = [],
  customAllow = [],
  rulesBuiltAt = 1,
} = {}) {
  const tabUpdates = [];
  const store = {
    rulesBuiltAt,
    guardHostsList: { block: listBlock, allow: listAllow },
    guardHostsCustom: { block: customBlock, allow: customAllow },
  };
  return {
    tabUpdates,
    chrome: {
      storage: {
        local: {
          get: async (defaults) => {
            const out = {};
            for (const key of Object.keys(defaults)) {
              out[key] = key in store ? store[key] : defaults[key];
            }
            return out;
          },
        },
      },
      tabs: {
        update: async (tabId, props) => {
          tabUpdates.push({ tabId, props });
        },
      },
      runtime: { getURL: (path) => `chrome-extension://testid${path}` },
    },
  };
}

async function withChrome(mock, fn) {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = mock.chrome;
  try {
    await fn();
  } finally {
    globalThis.chrome = originalChrome;
  }
}

test("guardNavigation redirects a blocked top-level navigation to the block page", async () => {
  const mock = makeChrome({ listBlock: ["example.com"], rulesBuiltAt: 11 });
  await withChrome(mock, async () => {
    await guardNavigation({ frameId: 0, url: "https://example.com/", tabId: 5 });
    assert.deepEqual(mock.tabUpdates, [
      {
        tabId: 5,
        props: { url: "chrome-extension://testid/src/blocked/blocked.html" },
      },
    ]);
  });
});

test("guardNavigation blocks subdomains of a listed host", async () => {
  const mock = makeChrome({ listBlock: ["example.com"], rulesBuiltAt: 14 });
  await withChrome(mock, async () => {
    await guardNavigation({
      frameId: 0,
      url: "https://news.ads.example.com/path",
      tabId: 8,
    });
    assert.equal(mock.tabUpdates.length, 1);
  });
});

test("guardNavigation honors a list allow exception", async () => {
  const mock = makeChrome({
    listBlock: ["example.com"],
    listAllow: ["safe.example.com"],
    rulesBuiltAt: 12,
  });
  await withChrome(mock, async () => {
    await guardNavigation({
      frameId: 0,
      url: "https://safe.example.com/",
      tabId: 7,
    });
    assert.equal(mock.tabUpdates.length, 0);
  });
});

test("guardNavigation lets a custom block override a list allow", async () => {
  const mock = makeChrome({
    listAllow: ["example.com"],
    customBlock: ["example.com"],
    rulesBuiltAt: 15,
  });
  await withChrome(mock, async () => {
    await guardNavigation({ frameId: 0, url: "https://example.com/", tabId: 2 });
    assert.equal(mock.tabUpdates.length, 1, "custom block wins over list allow");
  });
});

test("guardNavigation lets a custom allow override a list block", async () => {
  const mock = makeChrome({
    listBlock: ["example.com"],
    customAllow: ["example.com"],
    rulesBuiltAt: 16,
  });
  await withChrome(mock, async () => {
    await guardNavigation({ frameId: 0, url: "https://example.com/", tabId: 2 });
    assert.equal(mock.tabUpdates.length, 0, "custom allow wins over list block");
  });
});

test("guardNavigation does nothing when no host matches", async () => {
  const mock = makeChrome({ listBlock: ["example.com"], rulesBuiltAt: 13 });
  await withChrome(mock, async () => {
    await guardNavigation({
      frameId: 0,
      url: "https://allowed.example/",
      tabId: 9,
    });
    assert.equal(mock.tabUpdates.length, 0);
  });
});

test("guardNavigation skips subframes and non-http schemes", async () => {
  const mock = makeChrome({ listBlock: ["example.com"] });
  await withChrome(mock, async () => {
    await guardNavigation({ frameId: 1, url: "https://example.com/", tabId: 1 });
    await guardNavigation({
      frameId: 0,
      url: "chrome-extension://testid/src/blocked/blocked.html",
      tabId: 1,
    });
    assert.equal(mock.tabUpdates.length, 0);
  });
});

test("buildMatcher applies allow-over-block precedence across bands", () => {
  const matcher = buildMatcher({
    list: { block: ["a.com", "b.com"], allow: ["ok.a.com"] },
    custom: { block: ["c.com"], allow: ["b.com"] },
  });
  assert.equal(matcher.isBlocked("a.com"), true);
  assert.equal(matcher.isBlocked("deep.a.com"), true);
  assert.equal(matcher.isBlocked("ok.a.com"), false, "list allow beats block");
  assert.equal(matcher.isBlocked("b.com"), false, "custom allow beats list block");
  assert.equal(matcher.isBlocked("c.com"), true, "custom block");
  assert.equal(matcher.isBlocked("other.com"), false);
});

test("registerNavigationGuard registers the listener in every browser", () => {
  const originalChrome = globalThis.chrome;
  const originalNavigator = globalThis.navigator;
  const added = [];
  globalThis.chrome = {
    webNavigation: {
      onBeforeNavigate: { addListener: (fn) => added.push(fn) },
    },
  };

  try {
    globalThis.navigator = {}; // Chrome (no navigator.brave)
    registerNavigationGuard();
    assert.equal(added.length, 1, "registers without navigator.brave");

    globalThis.navigator = { brave: {} }; // Brave
    registerNavigationGuard();
    assert.equal(added.length, 2, "registers on Brave too");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.navigator = originalNavigator;
  }
});

test("registerNavigationGuard no-ops when webNavigation is unavailable", () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {};
  try {
    registerNavigationGuard(); // must not throw
  } finally {
    globalThis.chrome = originalChrome;
  }
});
