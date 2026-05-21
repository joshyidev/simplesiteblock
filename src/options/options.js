import { evaluate, hydrateIndex } from "../background/engine.js";
import { hashPassword, verifyPassword } from "../background/crypto.js";
import {
  createSettingsExport,
  importSettingsBackup,
} from "../background/backup.js";
import {
  addList,
  removeList,
  updateAllLists,
  updateCustomRules,
  updateListSettings,
} from "../background/lists.js";
import {
  getState,
  saveSettings,
} from "../background/storage.js";
import { extensionApi as ext } from "../extension_api.js";
import { isOptionsUnlocked, lockOptions, renderLock } from "./lock.js";

const app = document.querySelector("#app");
const lock = document.querySelector("#lock");
const shell = document.querySelector(".shell");
const manifest = ext.runtime.getManifest();
let lastPendingRebuild = false;

void boot();

async function boot() {
  const state = await getState();
  if (!isOptionsUnlocked(state.settings)) {
    shell.classList.add("is-locked");
    app.hidden = true;
    renderLock(lock, {
      verifyPassword,
      settings: state.settings,
      onUnlocked: () => void boot(),
    });
    return;
  }

  shell.classList.remove("is-locked");
  lock.hidden = true;
  app.hidden = false;
  renderApp(state);
}

function renderApp(state) {
  const totalRules = countRules(state.compiledIndex);
  const animatePendingIn = !lastPendingRebuild && state.pendingRebuild;
  const animatePendingOut = lastPendingRebuild && !state.pendingRebuild;

  app.innerHTML = `
    <div class="grid">
      <section class="panel span">
        <div class="section-header">
          <h2>Lists</h2>
          <p class="list-summary muted" id="listsMeta"></p>
        </div>
        <div class="section-actions list-controls">
          <label class="field-inline">
            Auto-update
            <select id="updateInterval">
              <option value="0" ${state.settings.updateIntervalDays === 0 ? "selected" : ""}>Manual</option>
              ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${state.settings.updateIntervalDays === d ? "selected" : ""}>${d} day${d === 1 ? "" : "s"}</option>`).join("")}
            </select>
          </label>
          <button id="updateAllButton" type="button">Update All</button>
          <p class="list-status muted" id="listsStatus" role="status" aria-live="polite"></p>
        </div>
        ${renderPendingNotice(state.pendingRebuild || animatePendingOut, state.pendingRebuild, animatePendingIn)}
        ${renderLists(state.lists)}
        <form id="addListForm" class="row add-list-form">
          <label class="field">
            Name
            <input name="name" placeholder="StevenBlack hosts">
          </label>
          <label class="field">
            URL
            <input name="url" type="url" placeholder="https://example.com/list.txt" required>
          </label>
          <button id="addListButton" class="fit" type="submit">Add list</button>
        </form>
      </section>

      <section class="panel span">
        <h2>Custom rules</h2>
        <form id="customRulesForm" class="custom-rules-form">
          <label class="field">
            <textarea id="customRules" name="customRules" aria-label="Domains or Adblock rules" spellcheck="false" rows="8" placeholder="example.com&#10;www.example.net # optional comment&#10;||example.org^ # include subdomains&#10;@@||allowed.example.org^ # allow">${escapeHtml(state.customRules)}</textarea>
          </label>
          <p class="muted">Use one domain per line. Plain domains match exactly; ||example.com^ includes subdomains; @@ allows a match.</p>
          <div class="form-actions custom-rules-actions">
            <button id="saveCustomRulesButton" class="fit" type="submit">Save rules</button>
            <p class="custom-rules-status muted" id="customRulesStatus" role="status" aria-live="polite"></p>
          </div>
        </form>
      </section>

      <section class="panel">
        <h2>Block action</h2>
        <p class="muted section-desc">Action to take when blocking conditions are met.</p>
        <div class="choice" id="blockActionChoices">
          <label><input type="radio" name="blockAction" value="show_block_page" ${state.settings.blockAction === "show_block_page" ? "checked" : ""}> Show blocked page</label>
          <label><input type="radio" name="blockAction" value="close_tab" ${state.settings.blockAction === "close_tab" ? "checked" : ""}> Close tab immediately</label>
        </div>
      </section>

      <section class="panel">
        <div class="section-header password-header">
          <h2>Password</h2>
          <div class="section-header-actions">
            <p class="password-status muted" id="passwordStatus" role="status" aria-live="polite"></p>
            ${state.settings.passwordEnabled ? `
              <button id="lockButton" class="ghost fit" type="button">Lock</button>
              <form id="disablePasswordForm"><button class="danger fit" type="submit">Disable</button></form>
            ` : ""}
          </div>
        </div>
        <p class="muted section-desc">Locks access to these options. The extension continues blocking while locked.</p>
        ${renderPassword(state.settings)}
      </section>

      <section class="panel">
        <h2>Import / Export</h2>
        <div class="backup-actions">
          <p class="muted section-desc">Saves and restores lists, custom rules, and settings.</p>
          <label class="checkline">
            <input id="includePasswordExport" type="checkbox">
            Include password settings when exporting
          </label>
          <div class="section-actions">
            <button id="exportSettingsButton" type="button">Export</button>
            <button id="importSettingsButton" class="ghost" type="button">Import</button>
            <input id="settingsImportFile" type="file" accept=".txt,.json,application/json,text/plain" hidden>
            <p class="backup-status muted" id="backupStatus" role="status" aria-live="polite"></p>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>Diagnostics</h2>
        <div class="row">
          <label class="field">
            Test URL
            <input id="testUrl" type="text" placeholder="example.com or https://example.com">
          </label>
          <button id="testUrlButton" class="fit" type="button">Test</button>
        </div>
        <output id="testVerdict" class="verdict">No test run.</output>
      </section>

      <section class="panel about-panel" aria-label="About ${escapeHtml(manifest.name)}">
        <div class="about-summary">
          <img class="about-icon" src="../../icons/icon256.png" alt="" width="64" height="64">
          <div>
            <p class="about-name">${escapeHtml(manifest.name)}</p>
            <p class="about-version muted">Version ${escapeHtml(manifest.version)}</p>
          </div>
        </div>
      </section>
    </div>
  `;

  const listsMeta = app.querySelector("#listsMeta");
  if (listsMeta) {
    const builtAt = state.compiledIndex?.builtAt
      ? new Date(state.compiledIndex.builtAt).toLocaleString()
      : "Never";
    listsMeta.textContent = `${totalRules.toLocaleString()} total rules · Index built ${builtAt}`;
  }

  bindEvents(state);
  animatePendingNoticeOut(animatePendingOut);
  lastPendingRebuild = state.pendingRebuild;
}

function renderPendingNotice(isVisible, isActive, shouldAnimateIn) {
  return `
    <p id="pendingNotice" class="pending-notice${isVisible ? " is-visible" : ""}${shouldAnimateIn ? " is-entering" : ""}" role="status" aria-live="polite" aria-hidden="${isActive ? "false" : "true"}">
      Pending changes — run <strong>Update All</strong> to apply.
    </p>
  `;
}

function animatePendingNoticeOut(shouldAnimate) {
  if (!shouldAnimate) return;
  const notice = app.querySelector("#pendingNotice");
  if (!notice) return;
  notice.getBoundingClientRect();
  notice.classList.remove("is-visible");
}

function renderPassword(settings) {
  if (!settings.passwordEnabled) {
    return `
      <form id="enablePasswordForm" class="row">
        <label class="field">
          New password
          <input name="password" type="password" autocomplete="new-password" required>
        </label>
        <label class="field">
          Confirm
          <input name="confirm" type="password" autocomplete="new-password" required>
        </label>
        <button class="fit password-submit" type="submit">Enable</button>
      </form>
    `;
  }

  return `
    <form id="changePasswordForm" class="row">
      <label class="field">
        New password
        <input name="password" type="password" autocomplete="new-password" required>
      </label>
      <label class="field">
        Confirm
        <input name="confirm" type="password" autocomplete="new-password" required>
      </label>
      <button class="fit password-submit" type="submit">Change</button>
    </form>
  `;
}

function renderLists(lists) {
  if (lists.length === 0) {
    return `<p class="muted">No lists added.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Enabled</th>
            <th>Name</th>
            <th>URL</th>
            <th>Rules</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${lists.map(renderListRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderListRow(list) {
  const error = list.lastError
    ? `<div class="error">${escapeHtml(list.lastError)}</div>`
    : "";
  return `
    <tr data-list-id="${escapeHtml(list.id)}">
      <td><input class="list-enabled" type="checkbox" ${list.enabled ? "checked" : ""} aria-label="Enabled"></td>
      <td>${escapeHtml(list.name)}</td>
      <td class="url-cell muted" title="${escapeHtml(list.url)}">${escapeHtml(list.url)}</td>
      <td>${Number(list.ruleCount || 0).toLocaleString()}${error}</td>
      <td class="actions">
        <button class="remove-list ghost" type="button">Remove</button>
      </td>
    </tr>
  `;
}

function bindEvents(state) {
  app
    .querySelector("#blockActionChoices")
    .addEventListener("change", async (event) => {
      if (event.target.name !== "blockAction") return;
      await saveSettings({ blockAction: event.target.value });
    });

  app
    .querySelector("#addListForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      try {
        await addList({
          name: form.get("name"),
          url: form.get("url"),
        });
        formElement.reset();
        await boot();
      } catch (error) {
        const message = error.message || "Something went wrong.";
        setListsStatus(message);
        window.alert(message);
      }
    });

  app
    .querySelector("#customRulesForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setCustomRulesStatus("Saving custom rules...");
      setIndexControlsDisabled(true);
      try {
        await updateCustomRules(form.get("customRules"));
        await boot();
        setCustomRulesStatus("Custom rules saved.");
      } catch (error) {
        setIndexControlsDisabled(false);
        const message = error.message || "Something went wrong.";
        setCustomRulesStatus(message);
        window.alert(message);
      }
    });

  app
    .querySelector("#updateInterval")
    .addEventListener("change", async (event) => {
      await saveSettings({ updateIntervalDays: Number(event.target.value) });
      setListsStatus("Auto-update interval saved.");
    });

  app.querySelector("#updateAllButton").addEventListener("click", async () => {
    setListsStatus("Updating lists...");
    setIndexControlsDisabled(true);
    try {
      await updateAllLists();
      await boot();
      setListsStatus("All lists updated.");
    } catch (error) {
      setIndexControlsDisabled(false);
      const message = error.message || "Something went wrong.";
      setListsStatus(message);
      window.alert(message);
    }
  });

  for (const row of app.querySelectorAll("tr[data-list-id]")) {
    const listId = row.dataset.listId;
    row
      .querySelector(".list-enabled")
      .addEventListener("change", async (event) => {
        await updateListSettings(listId, { enabled: event.target.checked });
        await boot();
      });
    row.querySelector(".remove-list").addEventListener("click", async () => {
      await removeList(listId);
      await boot();
    });
  }

  const enableForm = app.querySelector("#enablePasswordForm");
  if (enableForm) {
    enableForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = form.get("password");
      if (password !== form.get("confirm")) {
        setPasswordStatus("Passwords do not match.");
        return;
      }
      await saveSettings({
        passwordEnabled: true,
        passwordHash: await hashPassword(password),
      });
      sessionStorage.setItem("simpleSiteBlockUnlocked", "true");
      await boot();
      setPasswordStatus("Password enabled.");
    });
  }

  const changeForm = app.querySelector("#changePasswordForm");
  if (changeForm) {
    changeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = form.get("password");
      if (password !== form.get("confirm")) {
        setPasswordStatus("Passwords do not match.");
        return;
      }
      await saveSettings({
        passwordHash: await hashPassword(password),
      });
      await boot();
      setPasswordStatus("Password changed.");
    });
  }

  const disableForm = app.querySelector("#disablePasswordForm");
  if (disableForm) {
    disableForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveSettings({ passwordEnabled: false, passwordHash: null });
      lockOptions();
      await boot();
      setPasswordStatus("Password disabled.");
    });
  }

  const lockButton = app.querySelector("#lockButton");
  if (lockButton) {
    lockButton.addEventListener("click", () => {
      lockOptions();
      void boot();
    });
  }

  app.querySelector("#exportSettingsButton").addEventListener("click", () => {
    const includePassword = app.querySelector("#includePasswordExport").checked;
    const text = createSettingsExport(state, { includePassword });
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFileName();
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setBackupStatus("Settings exported.");
  });

  const importFile = app.querySelector("#settingsImportFile");
  app.querySelector("#importSettingsButton").addEventListener("click", () => {
    importFile.click();
  });
  importFile.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (
      !window.confirm(
        "Importing settings will replace current lists, rules, and options. Continue?",
      )
    ) {
      return;
    }

    setBackupStatus("Importing settings...");
    setIndexControlsDisabled(true);
    try {
      await importSettingsBackup(await file.text());
      const nextState = await getState();
      if (nextState.settings.passwordEnabled) {
        sessionStorage.setItem("simpleSiteBlockUnlocked", "true");
      } else {
        lockOptions();
      }
      await boot();
      setBackupStatus("Settings imported.");
    } catch (error) {
      setIndexControlsDisabled(false);
      const message = error.message || "Settings import failed.";
      setBackupStatus(message);
      window.alert(message);
    }
  });

  app.querySelector("#testUrlButton").addEventListener("click", async () => {
    const input = app.querySelector("#testUrl");
    const url = normalizeTestUrl(input.value);
    input.value = url;
    const { compiledIndex } = await getState();
    const verdict = evaluate(url, hydrateIndex(compiledIndex));
    const output = app.querySelector("#testVerdict");
    output.textContent = verdict.blocked
      ? `Blocked: ${verdict.reason}`
      : "Allowed";
    output.classList.toggle("is-blocked", verdict.blocked);
    output.classList.toggle("is-allowed", !verdict.blocked);
  });
}

function setListsStatus(message) {
  const listsStatus = app.querySelector("#listsStatus");
  if (listsStatus) {
    listsStatus.textContent = message;
  }
}

function setCustomRulesStatus(message) {
  const customRulesStatus = app.querySelector("#customRulesStatus");
  if (customRulesStatus) {
    customRulesStatus.textContent = message;
  }
}

function setBackupStatus(message) {
  const backupStatus = app.querySelector("#backupStatus");
  if (backupStatus) {
    backupStatus.textContent = message;
  }
}

function setPasswordStatus(message) {
  const passwordStatus = app.querySelector("#passwordStatus");
  if (passwordStatus) {
    passwordStatus.textContent = message;
  }
}

function setIndexControlsDisabled(disabled) {
  const selectors = [
    "#addListButton",
    "#saveCustomRulesButton",
    "#updateAllButton",
    "#importSettingsButton",
    "#testUrlButton",
    ".list-enabled",
    ".remove-list",
  ];

  for (const selector of selectors) {
    for (const control of app.querySelectorAll(selector)) {
      control.disabled = disabled;
    }
  }
}

function exportFileName() {
  const date = new Date().toISOString().slice(0, 10);
  return `simplesiteblock-settings-${date}.txt`;
}

function countRules(index) {
  return (
    (index.hostBlocksExact?.length || 0) +
    (index.hostAllowsExact?.length || 0) +
    (index.hostBlocksSubtree?.length || 0) +
    (index.hostAllowsSubtree?.length || 0) +
    (index.regexBlocks?.length || 0) +
    (index.regexAllows?.length || 0)
  );
}

function normalizeTestUrl(value) {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
