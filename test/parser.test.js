import assert from "node:assert/strict";
import test from "node:test";
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
