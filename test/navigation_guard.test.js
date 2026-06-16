import assert from "node:assert/strict";
import test from "node:test";
import {
  guardNavigation,
  registerNavigationGuard,
} from "../src/background/navigation_guard.js";

function makeChrome({
  matchedRules = [],
  dynamicRules = [],
  rulesBuiltAt = 1,
  blockAction = "redirect",
} = {}) {
  const tabUpdates = [];
  const tabRemovals = [];
  const testMatchCalls = [];
  return {
    tabUpdates,
    tabRemovals,
    testMatchCalls,
    chrome: {
      declarativeNetRequest: {
        testMatchOutcome: async (request) => {
          testMatchCalls.push(request);
          return { matchedRules };
        },
        getDynamicRules: async () => dynamicRules,
      },
      storage: {
        local: {
          get: async (defaults) => ({
            ...defaults,
            rulesBuiltAt,
            settings: { blockAction },
          }),
        },
      },
      tabs: {
        update: async (tabId, props) => {
          tabUpdates.push({ tabId, props });
        },
        remove: async (tabId) => {
          tabRemovals.push(tabId);
        },
      },
      runtime: { getURL: (path) => `chrome-extension://testid${path}` },
    },
  };
}

test("guardNavigation redirects a blocked top-level navigation to the block page", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChrome({
    matchedRules: [{ ruleId: 1000000, rulesetId: "_dynamic" }],
    dynamicRules: [{ id: 1000000, action: { type: "redirect" } }],
    rulesBuiltAt: 11,
  });
  globalThis.chrome = mock.chrome;

  try {
    await guardNavigation({
      frameId: 0,
      url: "https://example.com/",
      tabId: 5,
    });
    assert.deepEqual(mock.tabUpdates, [
      {
        tabId: 5,
        props: { url: "chrome-extension://testid/src/blocked/blocked.html" },
      },
    ]);
    assert.equal(mock.testMatchCalls[0].type, "main_frame");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("guardNavigation closes the tab when blockAction is close", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChrome({
    matchedRules: [{ ruleId: 1000000, rulesetId: "_dynamic" }],
    dynamicRules: [{ id: 1000000, action: { type: "redirect" } }],
    rulesBuiltAt: 21,
    blockAction: "close",
  });
  globalThis.chrome = mock.chrome;

  try {
    await guardNavigation({
      frameId: 0,
      url: "https://example.com/",
      tabId: 5,
    });
    assert.deepEqual(mock.tabRemovals, [5]);
    assert.equal(mock.tabUpdates.length, 0, "does not also redirect");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("guardNavigation ignores an allow-exception match", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChrome({
    matchedRules: [{ ruleId: 1, rulesetId: "_dynamic" }],
    dynamicRules: [
      { id: 1, action: { type: "allow" } },
      { id: 2, action: { type: "redirect" } },
    ],
    rulesBuiltAt: 12,
  });
  globalThis.chrome = mock.chrome;

  try {
    await guardNavigation({
      frameId: 0,
      url: "https://safe.example/",
      tabId: 7,
    });
    assert.equal(mock.tabUpdates.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("guardNavigation does nothing when no rule matches", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChrome({ matchedRules: [], rulesBuiltAt: 13 });
  globalThis.chrome = mock.chrome;

  try {
    await guardNavigation({
      frameId: 0,
      url: "https://allowed.example/",
      tabId: 9,
    });
    assert.equal(mock.tabUpdates.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("guardNavigation skips subframes and non-http schemes", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChrome({
    matchedRules: [{ ruleId: 1000000, rulesetId: "_dynamic" }],
    dynamicRules: [{ id: 1000000, action: { type: "redirect" } }],
  });
  globalThis.chrome = mock.chrome;

  try {
    await guardNavigation({
      frameId: 1,
      url: "https://example.com/",
      tabId: 1,
    });
    await guardNavigation({
      frameId: 0,
      url: "chrome-extension://testid/src/blocked/blocked.html",
      tabId: 1,
    });
    assert.equal(mock.tabUpdates.length, 0);
    assert.equal(
      mock.testMatchCalls.length,
      0,
      "filtered navigations never query the rules",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("guardNavigation leaves DNR to handle it when testMatchOutcome is unavailable", async () => {
  const originalChrome = globalThis.chrome;
  const mock = makeChrome();
  mock.chrome.declarativeNetRequest.testMatchOutcome = async () => {
    throw new Error("not supported");
  };
  globalThis.chrome = mock.chrome;

  try {
    await guardNavigation({
      frameId: 0,
      url: "https://example.com/",
      tabId: 3,
    });
    assert.equal(mock.tabUpdates.length, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
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
