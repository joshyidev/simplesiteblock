import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHosts } from "../src/background/normalize.js";
import { packRules } from "../src/background/packer.js";
import { applyDynamicRules } from "../src/background/rules.js";

test("normalizeHosts validates, lowercases, and converts IDNs", () => {
  const hosts = normalizeHosts([
    "Example.COM",
    "café.example.",
    "127.0.0.1",
    "localhost",
    "bad_host",
    "has/slash",
  ]);

  assert.equal(hosts.has("example.com"), true);
  assert.equal(hosts.has("xn--caf-dma.example"), true);
  assert.equal(hosts.has("127.0.0.1"), false);
  assert.equal(hosts.has("localhost"), false);
  assert.equal(hosts.has("bad_host"), false);
  assert.equal(hosts.size, 2);
});

test("normalizeHosts prunes subdomains already covered by a listed parent", () => {
  const hosts = normalizeHosts([
    "example.com",
    "www.example.com",
    "a.b.example.com",
    "ads.other.com",
  ]);

  assert.equal(hosts.has("example.com"), true);
  assert.equal(hosts.has("www.example.com"), false);
  assert.equal(hosts.has("a.b.example.com"), false);
  // No listed parent, so a standalone subdomain is kept.
  assert.equal(hosts.has("ads.other.com"), true);
  assert.equal(hosts.size, 2);
});

test("packRules emits redirect + block per batch and allow rules first", () => {
  const rules = packRules(
    new Set(["block.test"]),
    new Set(["allow.test"]),
  );

  assert.equal(rules.length, 3);

  const allowRule = rules[0];
  assert.equal(allowRule.action.type, "allow");
  assert.equal(allowRule.priority, 10);
  assert.deepEqual(allowRule.condition.requestDomains, ["allow.test"]);
  assert.ok(allowRule.condition.resourceTypes.includes("main_frame"));

  const redirectRule = rules[1];
  assert.equal(redirectRule.action.type, "redirect");
  assert.equal(
    redirectRule.action.redirect.extensionPath,
    "/src/blocked/blocked.html",
  );
  assert.deepEqual(redirectRule.condition.resourceTypes, ["main_frame"]);

  const blockRule = rules[2];
  assert.equal(blockRule.action.type, "block");
  assert.equal(blockRule.condition.resourceTypes.includes("main_frame"), false);

  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "rule ids are unique");
});

test("packRules batches at 1000 hosts per rule", () => {
  const block = new Set();
  for (let i = 0; i < 1001; i += 1) block.add(`host${i}.test`);

  const rules = packRules(block, new Set());
  // 1001 hosts -> 2 batches -> 2 redirect + 2 block rules.
  assert.equal(rules.length, 4);
  assert.equal(rules.filter((r) => r.action.type === "redirect").length, 2);
  assert.equal(rules.filter((r) => r.action.type === "block").length, 2);
});

test("packRules returns nothing when there are no hosts", () => {
  assert.deepEqual(packRules(new Set(), new Set()), []);
});

test("applyDynamicRules swaps the full rule set atomically", async () => {
  const originalChrome = globalThis.chrome;
  let update = null;
  globalThis.chrome = {
    declarativeNetRequest: {
      getDynamicRules: async () => [{ id: 5 }, { id: 9 }],
      updateDynamicRules: async (arg) => {
        update = arg;
      },
    },
  };

  try {
    const newRules = packRules(new Set(["block.test"]), new Set());
    await applyDynamicRules(newRules);
    assert.deepEqual(update.removeRuleIds, [5, 9]);
    assert.deepEqual(update.addRules, newRules);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("applyDynamicRules is a no-op without the DNR API", async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {};
  try {
    await applyDynamicRules([{ id: 1 }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
