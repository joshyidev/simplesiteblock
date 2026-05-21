export function isOptionsUnlocked(settings) {
  return (
    !settings.passwordEnabled ||
    sessionStorage.getItem("simpleSiteBlockUnlocked") === "true"
  );
}

export function lockOptions() {
  sessionStorage.removeItem("simpleSiteBlockUnlocked");
}

export function renderLock(
  container,
  { verifyPassword, settings, onUnlocked },
) {
  container.hidden = false;
  container.innerHTML = `
    <h2>Options locked</h2>
    <form id="unlockForm" class="row">
      <label class="field">
        Password
        <input id="unlockPassword" type="password" autocomplete="current-password" required>
      </label>
      <button class="fit" type="submit">Unlock</button>
    </form>
    <p class="lock-status muted" id="lockStatus" role="status" aria-live="polite"></p>
  `;

  container
    .querySelector("#unlockForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = container.querySelector("#unlockPassword").value;
      const ok = await verifyPassword(password, settings.passwordHash);
      if (!ok) {
        container.querySelector("#lockStatus").textContent = "Incorrect password.";
        return;
      }
      sessionStorage.setItem("simpleSiteBlockUnlocked", "true");
      container.hidden = true;
      container.innerHTML = "";
      onUnlocked();
    });
}
