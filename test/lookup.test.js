import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLookup, lookupHost } from "../src/background/lookup.js";
import { packRules } from "../src/background/packer.js";

test("evaluateLookup blocks an exact host match", () => {
  const rules = packRules(new Set(["example.com"]), new Set());
  const result = evaluateLookup("example.com", rules);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.matchedHost, "example.com");
});

test("evaluateLookup blocks a subdomain via its listed parent", () => {
  const rules = packRules(new Set(["example.com"]), new Set());
  const result = evaluateLookup("ads.cdn.example.com", rules);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.matchedHost, "example.com");
});

test("evaluateLookup lets an allow rule override a block", () => {
  const rules = packRules(new Set(["example.com"]), new Set(["example.com"]));
  const result = evaluateLookup("www.example.com", rules);
  assert.equal(result.verdict, "allowed");
  assert.equal(result.matchedHost, "example.com");
});

test("evaluateLookup respects custom priority over list allow rules", () => {
  const listRules = packRules(new Set(), new Set(["example.com"]));
  const customRules = packRules(new Set(["example.com"]), new Set(), {
    idBase: 1000000,
    allowPriority: 30,
    redirectPriority: 22,
    blockPriority: 21,
  });

  const result = evaluateLookup("www.example.com", [
    ...listRules,
    ...customRules,
  ]);

  assert.equal(result.verdict, "blocked");
  assert.equal(result.matchedHost, "example.com");
});

test("evaluateLookup returns none when nothing matches", () => {
  const rules = packRules(new Set(["example.com"]), new Set());
  const result = evaluateLookup("other.test", rules);
  assert.equal(result.verdict, "none");
  assert.equal(result.matchedHost, null);
});

test("evaluateLookup does not match on a bare TLD", () => {
  const rules = packRules(new Set(["com"]), new Set());
  // "com" cannot be packed as a valid host anyway, but guard the suffix walk.
  const result = evaluateLookup("example.com", rules);
  assert.equal(result.verdict, "none");
});

test("lookupHost rejects invalid input without querying rules", async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    declarativeNetRequest: {
      getDynamicRules: async () => {
        throw new Error("should not be called");
      },
    },
  };
  try {
    const result = await lookupHost("not a domain");
    assert.equal(result.ok, false);
    assert.match(result.error, /valid domain/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("lookupHost normalizes the query and reads applied rules", async () => {
  const originalChrome = globalThis.chrome;
  const rules = packRules(new Set(["example.com"]), new Set());
  globalThis.chrome = {
    declarativeNetRequest: {
      getDynamicRules: async () => rules,
    },
  };
  try {
    const result = await lookupHost("HTTPS://WWW.Example.com/path");
    assert.equal(result.ok, true);
    assert.equal(result.host, "www.example.com");
    assert.equal(result.verdict, "blocked");
    assert.equal(result.matchedHost, "example.com");
  } finally {
    globalThis.chrome = originalChrome;
  }
});
