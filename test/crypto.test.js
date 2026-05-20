import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/background/crypto.js";

test("hashPassword produces a structured record with algo, salt, iterations, hash", async () => {
  const result = await hashPassword("hunter2");
  assert.equal(result.algo, "PBKDF2-SHA-256");
  assert.equal(typeof result.salt, "string");
  assert.equal(typeof result.hash, "string");
  assert.equal(result.iterations, 250000);
  assert.ok(result.salt.length > 0);
  assert.ok(result.hash.length > 0);
});

test("hashPassword produces different salts for the same password", async () => {
  const a = await hashPassword("password");
  const b = await hashPassword("password");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test("verifyPassword returns true for the correct password", async () => {
  const stored = await hashPassword("correct-horse");
  assert.equal(await verifyPassword("correct-horse", stored), true);
});

test("verifyPassword returns false for a wrong password", async () => {
  const stored = await hashPassword("correct-horse");
  assert.equal(await verifyPassword("wrong-password", stored), false);
});

test("verifyPassword returns false for a corrupt stored record", async () => {
  assert.equal(await verifyPassword("any", null), false);
  assert.equal(await verifyPassword("any", {}), false);
  assert.equal(
    await verifyPassword("any", {
      algo: "PBKDF2-SHA-256",
      salt: null,
      hash: null,
    }),
    false,
  );
});

test("verifyPassword returns false for mismatched length hash", async () => {
  const stored = await hashPassword("password");
  const tampered = { ...stored, hash: btoa("short") };
  assert.equal(await verifyPassword("password", tampered), false);
});
