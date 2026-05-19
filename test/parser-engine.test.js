import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate,
  hydrateIndex,
  serializeIndex,
} from "../src/background/engine.js";
import { parseCustomRules, parseListText } from "../src/background/lists.js";
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

  assert.equal(parsed.hostBlocks.has("ads.example.com"), true);
  assert.equal(parsed.hostAllows.has("allowed.example.com"), true);
  assert.equal(parsed.regexBlocks.length, 3);
  assert.equal(parsed.warnings.length >= 2, true);
});

test("engine applies allow rules before block rules", () => {
  const index = hydrateIndex({
    hostBlocks: ["example.com"],
    hostAllows: ["safe.example.com"],
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

test("compiled index can serialize and hydrate", () => {
  const serialized = serializeIndex({
    hostBlocks: new Set(["b.example", "a.example"]),
    hostAllows: new Set(["allow.example"]),
    regexBlocks: [/ads/i],
    regexAllows: [{ source: "safe", flags: "i" }],
    builtAt: 42,
  });
  const hydrated = hydrateIndex(serialized);

  assert.deepEqual(serialized.hostBlocks, ["a.example", "b.example"]);
  assert.equal(evaluate("https://b.example", hydrated).blocked, true);
  assert.equal(evaluate("https://x.test/safe-ads.js", hydrated).blocked, false);
});

test("list parser automatically detects hosts or adblock format", () => {
  const hosts = parseListText("0.0.0.0 ads.example\n127.0.0.1 tracker.example");
  const adblock = parseListText("||ads.example^\n@@||safe.example^");

  assert.equal(hosts.detectedFormat, "hosts");
  assert.equal(adblock.detectedFormat, "adblock");
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
  assert.equal(parsed.hostBlocks.has("example-fakenews.test"), true);
  assert.equal(parsed.regexBlocks.length, 0);
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
    ||custom-block.test^
    @@||custom-allow.test^
    /custom-ad\\d+\\.js/
  `);

  assert.equal(parsed.detectedFormat, "adblock");
  assert.equal(parsed.hostBlocks.has("custom-block.test"), true);
  assert.equal(parsed.hostAllows.has("custom-allow.test"), true);
  assert.equal(parsed.regexBlocks.length, 1);
});

test("custom rules reject non-Adblock text", () => {
  assert.throws(
    () => parseCustomRules("hello\nnot a filter"),
    /valid Adblock/,
  );
});
