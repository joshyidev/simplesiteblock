const UNLOCKED_KEY = "simpleSiteBlockUnlocked";

export function isOptionsUnlocked(settings) {
  const gated =
    settings.passwordEnabled || (settings.unlockDelaySeconds || 0) > 0;
  if (!gated) return true;
  return sessionStorage.getItem(UNLOCKED_KEY) === "true";
}

export function lockOptions() {
  sessionStorage.removeItem(UNLOCKED_KEY);
}

export function formatRemaining(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function renderLock(container, { settings, onUnlocked }) {
  const delayMs = Math.max(0, (settings.unlockDelaySeconds || 0) * 1000);
  const passwordForm = settings.passwordEnabled
    ? `
    <form id="unlockForm" class="row" hidden>
      <label class="field">
        <input id="unlockPassword" type="password" autocomplete="current-password" aria-label="Password" required>
      </label>
      <button class="fit" type="submit">Unlock</button>
    </form>
  `
    : "";
  container.hidden = false;

  // Restart the countdown from full on every render, so a reload cannot shave
  // time off the wait (it always begins again at the configured delay).
  const deadline = Date.now() + delayMs;

  container.innerHTML = `
    <p class="eyebrow">SimpleSiteBlock</p>
    <div class="section-header lock-header">
      <h2>Options locked</h2>
      <div class="section-header-actions">
        <p class="lock-status muted" id="lockStatus" role="status" aria-live="polite"></p>
      </div>
    </div>
    <div class="lock-unlock-area${settings.passwordEnabled ? " has-password" : ""}">
      <p class="lock-countdown" id="lockCountdown" role="timer" aria-live="polite" hidden></p>
      ${passwordForm}
    </div>
  `;

  const countdownEl = container.querySelector("#lockCountdown");
  const form = settings.passwordEnabled
    ? container.querySelector("#unlockForm")
    : null;

  const finish = () => {
    container.hidden = true;
    container.innerHTML = "";
    onUnlocked();
  };

  const reveal = () => {
    countdownEl.hidden = true;
    if (form) {
      form.hidden = false;
      container.querySelector("#unlockPassword").focus();
    } else {
      // Delay-only gate: nothing left to enter, so unlock automatically.
      sessionStorage.setItem(UNLOCKED_KEY, "true");
      finish();
    }
  };

  if (delayMs <= 0 || Date.now() >= deadline) {
    reveal();
  } else {
    countdownEl.hidden = false;
    const tick = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        clearInterval(timer);
        reveal();
        return;
      }
      countdownEl.textContent = formatRemaining(remaining);
    };
    const timer = setInterval(tick, 250);
    tick();
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const password = container.querySelector("#unlockPassword").value;
      if (password !== settings.password) {
        container.querySelector("#lockStatus").textContent =
          "Incorrect password.";
        return;
      }
      sessionStorage.setItem(UNLOCKED_KEY, "true");
      finish();
    });
  }
}
