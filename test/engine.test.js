import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluate,
  hydrateIndex,
  matchesHostExact,
  matchesHostSubtree,
  serializeIndex,
} from "../src/background/engine.js";

test("engine applies allow rules before block rules", () => {
  const index = hydrateIndex({
    hostBlocksSubtree: ["example.com"],
    hostAllowsSubtree: ["safe.example.com"],
    builtAt: 1,
  });

  assert.equal(evaluate("https://www.example.com/page", index).blocked, true);
  assert.equal(evaluate("https://safe.example.com/page", index).blocked, false);
  assert.equal(evaluate("chrome://extensions", index).blocked, false);
});

test("engine treats exact host rules differently from subtree host rules", () => {
  const exact = hydrateIndex({
    hostBlocksExact: ["example.com"],
    builtAt: 1,
  });
  const subtree = hydrateIndex({
    hostBlocksSubtree: ["example.com"],
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
    builtAt: 42,
  });
  const hydrated = hydrateIndex(serialized);

  assert.deepEqual(serialized.hostBlocksExact, ["a.example", "b.example"]);
  assert.deepEqual(serialized.hostBlocksSubtree, ["subtree.example"]);
  assert.equal(Array.isArray(hydrated.hostBlocksExact), true);
  assert.equal(Array.isArray(hydrated.hostBlocksSubtree), true);
  assert.equal("regexBlocks" in serialized, false);
  assert.equal("regexAllows" in serialized, false);
  assert.equal(evaluate("https://b.example", hydrated).blocked, true);
  assert.equal(evaluate("https://x.b.example", hydrated).blocked, false);
  assert.equal(evaluate("https://x.subtree.example", hydrated).blocked, true);
});

test("host matching supports sorted arrays and empty indexes", () => {
  assert.equal(matchesHostExact(["a.example", "b.example"], "B.EXAMPLE"), true);
  assert.equal(matchesHostExact(["a.example", "b.example"], "c.example"), false);
  assert.equal(
    matchesHostSubtree(["example.com"], "deep.sub.example.com"),
    true,
  );
  assert.equal(matchesHostExact(undefined, "example.com"), false);
  assert.equal(matchesHostSubtree(undefined, "example.com"), false);
  assert.equal(
    evaluate("https://example.com", hydrateIndex({ builtAt: 1 })).blocked,
    false,
  );
});
