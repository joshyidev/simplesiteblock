import { createSettingsExport } from "../background/backup.js";
import {
  addList,
  removeList,
  updateListIdentity,
  updateListSettings,
} from "../background/lists.js";
import { getState, saveSettings } from "../background/storage.js";
import { extensionApi as ext } from "../extension_api.js";
import { isOptionsUnlocked, lockOptions, renderLock } from "./lock.js";

const app = document.querySelector("#app");
const lock = document.querySelector("#lock");
const shell = document.querySelector(".shell");
const manifest = ext.runtime.getManifest();
const MIN_PASSWORD_LENGTH = 8;
let lastPendingRebuild = false;
let editingListId = null;

void boot();

async function boot() {
  const state = await getState({ includeRawLists: false });
  if (!isOptionsUnlocked(state.settings)) {
    shell.classList.add("is-locked");
    app.hidden = true;
    renderLock(lock, {
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
  const animatePendingIn = !lastPendingRebuild && state.pendingRebuild;
  const animatePendingOut = lastPendingRebuild && !state.pendingRebuild;

  app.innerHTML = `
    <div class="grid">
      <section class="panel span">
        <div class="section-header">
          <h2>Lists</h2>
          <p class="list-summary muted" id="listsMeta">${escapeHtml(statsText(state))}</p>
        </div>
        <div class="section-actions list-controls">
          <label class="field-inline">
            Auto-update
            <select id="updateInterval" ${editingListId ? "disabled" : ""}>
              <option value="0" ${state.settings.updateIntervalDays === 0 ? "selected" : ""}>Manual</option>
              ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${state.settings.updateIntervalDays === d ? "selected" : ""}>${d} day${d === 1 ? "" : "s"}</option>`).join("")}
            </select>
          </label>
          <button id="updateAllButton" type="button" ${editingListId ? "disabled" : ""}>Update All</button>
          <p class="list-status muted" id="listsStatus" role="status" aria-live="polite"></p>
        </div>
        ${renderPendingNotice(state.pendingRebuild || animatePendingOut, state.pendingRebuild, animatePendingIn)}
        ${renderLists(state.lists)}
        <form id="addListForm" class="row add-list-form">
          <label class="field">
            Name
            <input name="name" placeholder="StevenBlack hosts" ${editingListId ? "disabled" : ""}>
          </label>
          <label class="field">
            URL
            <input name="url" type="url" placeholder="https://example.com/list.txt" required ${editingListId ? "disabled" : ""}>
          </label>
          <button id="addListButton" class="fit" type="submit" ${editingListId ? "disabled" : ""}>Add list</button>
        </form>
      </section>

      <section class="panel span">
        <h2>Custom rules</h2>
        <p class="muted section-desc">One domain per line (up to 1000) — each blocks that domain and all its subdomains. Prefix a line with @@ to allow it instead.</p>
        <form id="customRulesForm" class="custom-rules-form">
          <label class="field">
            <textarea id="customRules" name="customRules" aria-label="Domains to block, one per line" spellcheck="false" rows="8" placeholder="example.com&#10;ads.example.net # optional comment&#10;@@allowed.example.org # allow instead of block">${escapeHtml(state.customRules)}</textarea>
          </label>
          <div class="form-actions custom-rules-actions">
            <button id="saveCustomRulesButton" class="fit" type="submit">Save rules</button>
            <p class="custom-rules-status muted" id="customRulesStatus" role="status" aria-live="polite"></p>
          </div>
        </form>
      </section>

      <section class="panel">
        <h2>Block page</h2>
        <p class="muted section-desc">Add a message to the block page. Leave blank to use the default.</p>
        <form id="blockMessageForm" class="custom-rules-form">
          <label class="field">
            <input id="blockMessage" name="blockMessage" type="text" aria-label="Block page message" placeholder="Message shown on the block page" value="${escapeHtml(state.settings.blockPageMessage)}">
          </label>
          <div class="form-actions custom-rules-actions">
            <button id="saveBlockMessageButton" class="fit" type="submit">Save message</button>
            <p class="custom-rules-status muted" id="blockMessageStatus" role="status" aria-live="polite"></p>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="section-header password-header">
          <h2>Password</h2>
          <div class="section-header-actions">
            <p class="password-status muted" id="passwordStatus" role="status" aria-live="polite"></p>
            ${
              state.settings.passwordEnabled
                ? `
              <button id="lockButton" class="ghost fit" type="button">Lock</button>
              <form id="disablePasswordForm"><button class="danger fit" type="submit">Disable</button></form>
            `
                : ""
            }
          </div>
        </div>
        <p class="muted section-desc">Locks access to these options. The extension continues blocking while locked.</p>
        ${renderPassword(state.settings)}
      </section>

      <section class="panel">
        <h2>Import / Export Settings</h2>
        <div class="backup-actions">
          <label class="checkline">
            <input id="includePasswordExport" type="checkbox">
            Include password settings when exporting
          </label>
          <div class="section-actions">
            <button id="exportSettingsButton" type="button">Export</button>
            <button id="importSettingsButton" type="button">Import</button>
            <input id="settingsImportFile" type="file" accept=".txt,.json,application/json,text/plain" hidden>
            <p class="backup-status muted" id="backupStatus" role="status" aria-live="polite"></p>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>Diagnostics</h2>
        <div class="row">
          <label class="field">
            <input id="lookupInput" type="text" aria-label="Domain to check" placeholder="example.com or https://example.com">
          </label>
          <button id="lookupButton" class="fit" type="button">Check</button>
        </div>
        <output id="lookupResult" class="verdict">No lookup run.</output>
      </section>

      <section class="panel">
        <h2>Links</h2>
        <nav class="link-list" aria-label="Help and project links">
          <a href="https://github.com/joshyidev/simplesiteblock/wiki">Documentation</a>
          <a href="https://github.com/joshyidev/simplesiteblock/releases">Changelog</a>
          <a href="https://github.com/joshyidev/simplesiteblock/issues">Bug report (GitHub)</a>
          <a href="https://github.com/joshyidev/simplesiteblock">Source code (MIT)</a>
          <a href="https://github.com/joshyidev/simplesiteblock/wiki/Privacy-Policy">Privacy Policy</a>
        </nav>
      </section>

      <section class="panel about-panel" aria-label="About ${escapeHtml(manifest.name)}">
        <div class="about-summary">
          <img class="about-icon" src="../../icons/icon128.png" alt="" width="64" height="64">
          <div>
            <p class="about-name">${escapeHtml(manifest.name)}</p>
            <p class="about-version">${escapeHtml(manifest.version)}</p>
            <p class="about-version">Joshua Yi</p>
          </div>
        </div>
      </section>
    </div>
  `;

  bindEvents(state);
  animatePendingNoticeOut(animatePendingOut);
  lastPendingRebuild = state.pendingRebuild;
}

// Reads the blocked-domain count recorded by the worker at rebuild time rather
// than pulling the full dynamic rule set into the page (which spikes memory on
// large lists). Synchronous, so the stats render with the rest of the page.
function statsText(state) {
  const built = state.rulesBuiltAt
    ? new Date(state.rulesBuiltAt).toLocaleString()
    : "Never";
  const domains =
    (state.appliedListDomainCount || 0) + (state.appliedCustomDomainCount || 0);
  return `${domains.toLocaleString()} domains blocked · Built ${built}`;
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
          <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
        </label>
        <label class="field">
          Confirm
          <input name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
        </label>
        <button class="fit password-submit" type="submit">Enable</button>
      </form>
    `;
  }

  return `
    <form id="changePasswordForm" class="row">
      <label class="field">
        New password
        <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
      </label>
      <label class="field">
        Confirm
        <input name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
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
  if (list.id === editingListId) {
    return `
      <tr data-list-id="${escapeHtml(list.id)}">
        <td><input class="list-enabled" type="checkbox" ${list.enabled ? "checked" : ""} aria-label="Enabled" disabled></td>
        <td><input class="edit-list-name" type="text" aria-label="List name" value="${escapeHtml(list.name)}"></td>
        <td><input class="edit-list-url" type="url" aria-label="List URL" value="${escapeHtml(list.url)}" required></td>
        <td>${Number(list.ruleCount || 0).toLocaleString()}${error}</td>
        <td class="actions">
          <button class="save-list-edit ghost" type="button">Save</button>
          <button class="cancel-list-edit ghost danger" type="button">Cancel</button>
        </td>
      </tr>
    `;
  }

  const actionDisabled = editingListId ? "disabled" : "";
  return `
    <tr data-list-id="${escapeHtml(list.id)}">
      <td><input class="list-enabled" type="checkbox" ${list.enabled ? "checked" : ""} aria-label="Enabled"></td>
      <td class="name-cell" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</td>
      <td class="url-cell muted" title="${escapeHtml(list.url)}">${escapeHtml(list.url)}</td>
      <td>${Number(list.ruleCount || 0).toLocaleString()}${error}</td>
      <td class="actions">
        <button class="edit-list" type="button" ${actionDisabled}>Edit</button>
        <button class="remove-list danger" type="button" ${actionDisabled}>Remove</button>
      </td>
    </tr>
  `;
}

function bindEvents(state) {
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
        await runBackgroundCommand({
          type: "ssb:update-custom-rules",
          rawRules: form.get("customRules"),
        });
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
    .querySelector("#blockMessageForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      await saveSettings({ blockPageMessage: form.get("blockMessage") });
      await boot();
      const status = app.querySelector("#blockMessageStatus");
      if (status) status.textContent = "Block page message saved.";
    });

  app
    .querySelector("#updateInterval")
    .addEventListener("change", async (event) => {
      await saveSettings({ updateIntervalDays: Number(event.target.value) });
      await boot();
      setListsStatus("Auto-update interval saved.");
    });

  app.querySelector("#updateAllButton").addEventListener("click", async () => {
    setListsStatus("Updating lists...");
    setIndexControlsDisabled(true);
    try {
      await runBackgroundCommand({ type: "ssb:update-all-lists" });
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
    const enabledInput = row.querySelector(".list-enabled:not(:disabled)");
    if (enabledInput) {
      enabledInput.addEventListener("change", async (event) => {
        await updateListSettings(listId, { enabled: event.target.checked });
        await boot();
      });
    }

    const editButton = row.querySelector(".edit-list");
    if (editButton) {
      editButton.addEventListener("click", async () => {
        editingListId = listId;
        await boot();
      });
    }

    const saveEditButton = row.querySelector(".save-list-edit");
    if (saveEditButton) {
      saveEditButton.addEventListener("click", async () => {
        setListsStatus("Saving list...");
        setIndexControlsDisabled(true);
        try {
          await updateListIdentity(listId, {
            name: row.querySelector(".edit-list-name").value,
            url: row.querySelector(".edit-list-url").value,
          });
          editingListId = null;
          await boot();
          setListsStatus("List saved.");
        } catch (error) {
          setIndexControlsDisabled(false);
          const message = error.message || "Something went wrong.";
          setListsStatus(message);
          window.alert(message);
        }
      });
    }

    const cancelEditButton = row.querySelector(".cancel-list-edit");
    if (cancelEditButton) {
      cancelEditButton.addEventListener("click", async () => {
        editingListId = null;
        await boot();
      });
    }

    const removeButton = row.querySelector(".remove-list");
    if (removeButton) {
      removeButton.addEventListener("click", async () => {
        const list = state.lists.find((item) => item.id === listId);
        const listName = list?.name || "this list";
        if (!window.confirm(`Remove "${listName}"?`)) return;
        await removeList(listId);
        if (editingListId === listId) editingListId = null;
        await boot();
      });
    }
  }

  const enableForm = app.querySelector("#enablePasswordForm");
  if (enableForm) {
    enableForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = form.get("password");
      if (!isPasswordLongEnough(password)) {
        setPasswordStatus("Password must be at least 8 characters.");
        return;
      }
      if (password !== form.get("confirm")) {
        setPasswordStatus("Passwords do not match.");
        return;
      }
      await saveSettings({
        passwordEnabled: true,
        password,
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
      if (!isPasswordLongEnough(password)) {
        setPasswordStatus("Password must be at least 8 characters.");
        return;
      }
      if (password !== form.get("confirm")) {
        setPasswordStatus("Passwords do not match.");
        return;
      }
      await saveSettings({
        password,
      });
      await boot();
      setPasswordStatus("Password changed.");
    });
  }

  const disableForm = app.querySelector("#disablePasswordForm");
  if (disableForm) {
    disableForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveSettings({ passwordEnabled: false, password: "" });
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
      await runBackgroundCommand({
        type: "ssb:import-settings",
        text: await file.text(),
      });
      const nextState = await getState({ includeRawLists: false });
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

  app.querySelector("#lookupButton").addEventListener("click", async () => {
    const value = app.querySelector("#lookupInput").value;
    const output = app.querySelector("#lookupResult");
    output.classList.remove("is-blocked", "is-allowed");

    let result;
    try {
      result = await ext.runtime.sendMessage({
        type: "ssb:lookup",
        input: value,
      });
    } catch {
      result = null;
    }
    if (!result) {
      output.textContent = "Lookup unavailable. Try again in a moment.";
      return;
    }
    if (!result.ok) {
      output.textContent = result.error;
      return;
    }
    if (result.verdict === "blocked") {
      output.textContent = `Blocked — matched ${result.matchedHost}`;
      output.classList.add("is-blocked");
    } else if (result.verdict === "allowed") {
      output.textContent = `Allowed — an allow rule for ${result.matchedHost} overrides any block`;
      output.classList.add("is-allowed");
    } else {
      output.textContent = `Not blocked — ${result.host} is not in any list`;
    }
  });
}

function setListsStatus(message) {
  const listsStatus = app.querySelector("#listsStatus");
  if (listsStatus) {
    listsStatus.textContent = message;
  }
}

async function runBackgroundCommand(message) {
  let response;
  try {
    response = await ext.runtime.sendMessage(message);
  } catch {
    throw new Error("Background worker unavailable. Try again in a moment.");
  }
  if (response?.ok) return response;
  throw new Error(response?.error || "Background worker unavailable.");
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

function isPasswordLongEnough(password) {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

function setIndexControlsDisabled(disabled) {
  const selectors = [
    "#addListButton",
    "#saveCustomRulesButton",
    "#updateAllButton",
    "#importSettingsButton",
    ".list-enabled",
    ".edit-list",
    ".save-list-edit",
    ".cancel-list-edit",
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
