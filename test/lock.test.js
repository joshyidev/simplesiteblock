import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  formatRemaining,
  isOptionsUnlocked,
  lockOptions,
  renderLock,
} from "../src/options/lock.js";

const UNLOCKED_KEY = "simpleSiteBlockUnlocked";

function installSessionStorage() {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => void store.clear(),
  };
  return store;
}

// Minimal element stub: every querySelector(selector) returns a shared node so
// renderLock can wire and toggle the elements it expects after setting innerHTML.
function makeContainer() {
  const nodes = new Map();
  // Mirror the template: the countdown and unlock form start with `hidden`.
  const initiallyHidden = new Set(["#lockCountdown", "#unlockForm"]);
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        hidden: initiallyHidden.has(id),
        textContent: "",
        value: "",
        focus() {
          this.focused = true;
        },
        _handlers: {},
        addEventListener(type, fn) {
          this._handlers[type] = fn;
        },
      });
    }
    return nodes.get(id);
  };
  return {
    hidden: false,
    innerHTML: "",
    querySelector: (selector) => node(selector),
    _node: node,
  };
}

// Capture interval callbacks instead of scheduling real timers, so a running
// countdown never leaks a real interval that keeps the test process alive.
let intervals;
let realSetInterval;
let realClearInterval;

beforeEach(() => {
  installSessionStorage();
  intervals = new Map();
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;
  let nextId = 1;
  globalThis.setInterval = (fn) => {
    const id = nextId++;
    intervals.set(id, fn);
    return id;
  };
  globalThis.clearInterval = (id) => void intervals.delete(id);
});

afterEach(() => {
  delete globalThis.sessionStorage;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

// Fire every registered interval callback once (one countdown tick).
function tickIntervals() {
  for (const fn of intervals.values()) fn();
}

test("formatRemaining renders seconds under a minute and mm:ss above", () => {
  assert.equal(formatRemaining(0), "0");
  assert.equal(formatRemaining(1500), "2");
  assert.equal(formatRemaining(59_000), "59");
  assert.equal(formatRemaining(60_000), "1:00");
  assert.equal(formatRemaining(125_000), "2:05");
});

test("isOptionsUnlocked: ungated config is always unlocked", () => {
  assert.equal(
    isOptionsUnlocked({ passwordEnabled: false, unlockDelaySeconds: 0 }),
    true,
  );
});

test("isOptionsUnlocked: a delay alone gates until the session flag is set", () => {
  const settings = { passwordEnabled: false, unlockDelaySeconds: 30 };
  assert.equal(isOptionsUnlocked(settings), false);
  sessionStorage.setItem(UNLOCKED_KEY, "true");
  assert.equal(isOptionsUnlocked(settings), true);
});

test("isOptionsUnlocked: a password gates until the session flag is set", () => {
  const settings = { passwordEnabled: true, unlockDelaySeconds: 0 };
  assert.equal(isOptionsUnlocked(settings), false);
  sessionStorage.setItem(UNLOCKED_KEY, "true");
  assert.equal(isOptionsUnlocked(settings), true);
});

test("lockOptions clears the unlock flag", () => {
  sessionStorage.setItem(UNLOCKED_KEY, "true");
  lockOptions();
  assert.equal(sessionStorage.getItem(UNLOCKED_KEY), null);
});

test("renderLock reveals the password form immediately with no delay", () => {
  const container = makeContainer();
  let unlocked = false;
  renderLock(container, {
    settings: { passwordEnabled: true, password: "pw", unlockDelaySeconds: 0 },
    onUnlocked: () => (unlocked = true),
  });

  assert.equal(container._node("#unlockForm").hidden, false);
  assert.equal(container._node("#lockCountdown").hidden, true);
  assert.equal(unlocked, false);
});

test("renderLock restarts the countdown from full on every render", () => {
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const container = makeContainer();
    let unlocked = false;
    // A prior render would have left progress behind; restart-from-full means a
    // fresh render still shows the full delay and does not unlock early.
    renderLock(container, {
      settings: {
        passwordEnabled: false,
        password: "",
        unlockDelaySeconds: 30,
      },
      onUnlocked: () => (unlocked = true),
    });

    assert.equal(unlocked, false);
    assert.equal(container._node("#lockCountdown").hidden, false);
    assert.equal(container._node("#lockCountdown").textContent, "30");
  } finally {
    Date.now = realNow;
  }
});

test("renderLock omits the password input for delay-only locks", () => {
  const container = makeContainer();
  renderLock(container, {
    settings: {
      passwordEnabled: false,
      password: "",
      unlockDelaySeconds: 30,
    },
    onUnlocked: () => {},
  });

  assert.equal(container.innerHTML.includes("unlockPassword"), false);
  assert.equal(container.innerHTML.includes("unlockForm"), false);
});

test("renderLock keeps the password form hidden while the countdown runs", () => {
  const container = makeContainer();
  let unlocked = false;
  renderLock(container, {
    settings: { passwordEnabled: true, password: "pw", unlockDelaySeconds: 30 },
    onUnlocked: () => (unlocked = true),
  });

  assert.equal(unlocked, false);
  assert.equal(container._node("#lockCountdown").hidden, false);
  assert.equal(container._node("#unlockForm").hidden, true);
  assert.equal(sessionStorage.getItem(UNLOCKED_KEY), null);
});

test("renderLock unlock handler rejects wrong passwords and accepts the right one", () => {
  const container = makeContainer();
  let unlocked = false;
  renderLock(container, {
    settings: {
      passwordEnabled: true,
      password: "secret",
      unlockDelaySeconds: 0,
    },
    onUnlocked: () => (unlocked = true),
  });

  const form = container._node("#unlockForm");
  const submit = form._handlers.submit;
  const event = { preventDefault() {} };

  container._node("#unlockPassword").value = "wrong";
  submit(event);
  assert.equal(unlocked, false);
  assert.equal(
    container._node("#lockStatus").textContent,
    "Incorrect password.",
  );

  container._node("#unlockPassword").value = "secret";
  submit(event);
  assert.equal(unlocked, true);
  assert.equal(sessionStorage.getItem(UNLOCKED_KEY), "true");
});

test("renderLock starts a countdown and reveals after the deadline elapses", () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    const container = makeContainer();
    let unlocked = false;
    renderLock(container, {
      settings: { passwordEnabled: false, password: "", unlockDelaySeconds: 2 },
      onUnlocked: () => (unlocked = true),
    });

    const countdown = container._node("#lockCountdown");
    assert.equal(countdown.hidden, false);
    assert.equal(countdown.textContent, "2");
    assert.equal(unlocked, false);

    now += 2000; // deadline reached
    tickIntervals();
    assert.equal(unlocked, true);
    assert.equal(sessionStorage.getItem(UNLOCKED_KEY), "true");
  } finally {
    Date.now = realNow;
  }
});

test("renderLock reveals the password form when the countdown elapses", () => {
  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;

  try {
    const container = makeContainer();
    renderLock(container, {
      settings: {
        passwordEnabled: true,
        password: "pw",
        unlockDelaySeconds: 2,
      },
      onUnlocked: () => {},
    });

    assert.equal(container._node("#unlockForm").hidden, true);

    now += 2000;
    tickIntervals();
    assert.equal(container._node("#unlockForm").hidden, false);
    assert.equal(container._node("#unlockPassword").focused, true);
    assert.equal(sessionStorage.getItem(UNLOCKED_KEY), null);
  } finally {
    Date.now = realNow;
  }
});
