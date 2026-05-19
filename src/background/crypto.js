const ALGO = "PBKDF2-SHA-256";
const ITERATIONS = 250000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return {
    algo: ALGO,
    salt: bytesToBase64(salt),
    iterations: ITERATIONS,
    hash: bytesToBase64(hash),
  };
}

export async function verifyPassword(password, stored) {
  if (!stored || stored.algo !== ALGO || !stored.salt || !stored.hash)
    return false;
  const salt = base64ToBytes(stored.salt);
  const expected = base64ToBytes(stored.hash);
  const actual = await derive(password, salt, stored.iterations || ITERATIONS);
  return constantTimeEqual(actual, expected);
}

async function derive(password, salt, iterations) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
