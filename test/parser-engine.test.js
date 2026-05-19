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
  const domains = parseListText("# comment\nexample.com\nexample.org # comment");

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
  assert.throws(
    () => parseCustomRules("hello\nnot a filter"),
    /valid Adblock/,
  );
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
