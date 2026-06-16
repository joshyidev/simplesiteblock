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
} = {}) {
  const tabUpdates = [];
  const testMatchCalls = [];
  return {
    tabUpdates,
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
        local: { get: async (defaults) => ({ ...defaults, rulesBuiltAt }) },
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

test("registerNavigationGuard only registers the listener on Brave", () => {
  const originalChrome = globalThis.chrome;
  const originalNavigator = globalThis.navigator;
  const added = [];
  const chromeMock = {
    webNavigation: {
      onBeforeNavigate: { addListener: (fn) => added.push(fn) },
    },
  };
  globalThis.chrome = chromeMock;

  try {
    globalThis.navigator = {}; // no .brave -> Chrome
    registerNavigationGuard();
    assert.equal(added.length, 0, "no listener off Brave");

    globalThis.navigator = { brave: {} }; // Brave injects navigator.brave
    registerNavigationGuard();
    assert.equal(added.length, 1, "listener registered on Brave");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.navigator = originalNavigator;
  }
});
