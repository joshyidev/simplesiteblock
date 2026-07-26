import { createSettingsExport } from "../background/backup.js";
import { getState, saveSettings } from "../background/storage.js";
import { extensionApi as ext } from "../extension_api.js";
import { isOptionsUnlocked, lockOptions, renderLock } from "./lock.js";

const app = document.querySelector("#app");
const lock = document.querySelector("#lock");
const shell = document.querySelector(".shell");
const manifest = ext.runtime.getManifest();
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_TAB = "lists";
const OPTION_TABS = [
  { id: "lists", label: "Lists" },
  { id: "rules", label: "Custom rules" },
  { id: "settings", label: "Settings" },
  { id: "support", label: "Support" },
  { id: "about", label: "About" },
];
let editingListId = null;
let activeTab = readActiveTab();

void boot();

window.addEventListener("hashchange", () => {
  const nextTab = readActiveTab();
  if (nextTab === activeTab) return;
  if (app.hidden) {
    // App is locked/not rendered; remember the target so it applies on unlock.
    activeTab = nextTab;
    return;
  }
  setActiveTab(nextTab, { updateLocation: false });
});

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
  if (!isKnownTab(activeTab)) activeTab = DEFAULT_TAB;

  app.innerHTML = `
    ${renderTabs(state.settings)}
    <div class="tab-panels">
      ${renderTabPanel("lists", renderListsTab(state))}
      ${renderTabPanel("rules", renderRulesTab(state))}
      ${renderTabPanel("settings", renderSettingsTab(state))}
      ${renderTabPanel("support", renderSupportTab())}
      ${renderTabPanel("about", renderAboutTab())}
    </div>
  `;

  bindTabs();
  bindEvents(state);
}

function renderTabs(settings) {
  const gated = settings.passwordEnabled || settings.unlockDelaySeconds > 0;
  return `
    <div class="tab-bar">
      <nav class="tabs" role="tablist" aria-label="Options pages">
        ${OPTION_TABS.map((tab) => {
          const selected = tab.id === activeTab;
          return `
            <button
              id="tab-${escapeHtml(tab.id)}"
              class="tab-button"
              type="button"
              role="tab"
              aria-controls="panel-${escapeHtml(tab.id)}"
              aria-selected="${selected ? "true" : "false"}"
              data-tab-id="${escapeHtml(tab.id)}"
              tabindex="${selected ? "0" : "-1"}"
            >${escapeHtml(tab.label)}</button>
          `;
        }).join("")}
      </nav>
      ${gated ? `<button id="lockButton" class="ghost tab-lock" type="button">Lock</button>` : ""}
    </div>
  `;
}

function renderTabPanel(tabId, content) {
  return `
    <section
      id="panel-${escapeHtml(tabId)}"
      class="tab-panel"
      role="tabpanel"
      aria-labelledby="tab-${escapeHtml(tabId)}"
      data-tab-id="${escapeHtml(tabId)}"
      ${tabId === activeTab ? "" : "hidden"}
    >
      ${content}
    </section>
  `;
}

function renderListsTab(state) {
  return `
    <div class="page lists-page">
      <div class="page-header">
        <div class="page-toolbar list-controls">
          <button id="updateAllButton" type="button" ${editingListId ? "disabled" : ""}>Update lists</button>
          <p class="list-status muted" id="listsStatus" role="status" aria-live="polite"></p>
        </div>
        <p class="page-meta muted list-summary" id="listsMeta">${statsHtml(state)}</p>
      </div>
      <div class="list-divider" aria-hidden="true"></div>
      ${renderRuleBuildErrors(state)}
      ${renderLists(state.lists)}
      <form id="addListForm" class="row add-list-form field-group">
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
    </div>
  `;
}

function renderRulesTab(state) {
  return `
    <div class="page rules-page">
      <form id="customRulesForm" class="custom-rules-form">
        <p class="page-desc muted custom-rules-desc">One domain per line (up to 1000) — each blocks that domain and all its subdomains. Prefix a line with @@ to allow it instead.</p>
        <label class="field">
          <textarea id="customRules" name="customRules" aria-label="Domains to block, one per line" spellcheck="false" rows="8" placeholder="example.com&#10;ads.example.net # optional comment&#10;@@allowed.example.org # allow instead of block">${escapeHtml(state.customRules)}</textarea>
        </label>
        <div class="page-toolbar custom-rules-actions">
          <button id="saveCustomRulesButton" class="fit" type="submit">Save rules</button>
          <p class="custom-rules-status muted" id="customRulesStatus" role="status" aria-live="polite"></p>
        </div>
      </form>
    </div>
  `;
}

function renderSettingsTab(state) {
  return `
    <div class="page settings-page">
      <div class="setting-block setting-block-stack">
        <div class="setting-copy">
          <h3>General</h3>
        </div>
        <div class="setting-control general-settings">
          <div class="setting-row">
            <label class="field-inline">
              Auto-update lists every
              <select id="updateInterval" ${editingListId ? "disabled" : ""}>
                <option value="0" ${state.settings.updateIntervalDays === 0 ? "selected" : ""}>Manual</option>
                ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${state.settings.updateIntervalDays === d ? "selected" : ""}>${d} day${d === 1 ? "" : "s"}</option>`).join("")}
              </select>
            </label>
            <p class="auto-update-status muted" id="autoUpdateStatus" role="status" aria-live="polite"></p>
          </div>
        </div>
      </div>

      <div class="setting-block">
        <div class="setting-heading">
          <div class="setting-copy">
            <h3>Password</h3>
            <p class="page-desc muted">Set a password to lock access to these options. Set a blank password to disable it.</p>
          </div>
        </div>
        ${renderPassword(state.settings)}
      </div>

      <div class="setting-block">
        <div class="setting-heading">
          <div class="setting-copy">
            <h3>Countdown Timer</h3>
            <p class="page-desc muted">Set a countdown timer before the options unlock.</p>
          </div>
        </div>
        <form id="unlockDelayForm" class="setting-row">
          <label class="field-inline">
            Timer duration:
            <select class="delay-select" name="unlockDelaySeconds">
              ${renderDelayOptions(state.settings.unlockDelaySeconds)}
            </select>
          </label>
          <button class="fit" type="submit">Save</button>
          <p class="delay-status muted" id="delayStatus" role="status" aria-live="polite"></p>
        </form>
      </div>

      <div class="setting-block setting-block-stack">
        <div class="setting-copy">
          <h3>Import / Export Settings</h3>
        </div>
        <div class="backup-actions">
          <label class="checkline">
            <input id="includePasswordExport" type="checkbox">
            Include password settings when exporting
          </label>
          <div class="page-toolbar">
            <button id="exportSettingsButton" type="button">Export</button>
            <button id="importSettingsButton" type="button">Import</button>
            <input id="settingsImportFile" type="file" accept=".txt,.json,application/json,text/plain" hidden>
            <p class="backup-status muted" id="backupStatus" role="status" aria-live="polite"></p>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSupportTab() {
  return `
    <div class="page support-page">
      <div class="setting-block setting-block-stack">
        <div class="setting-copy">
          <h3>Documentation</h3>
          <p class="page-desc muted">Learn supported rule formats, matching behavior, limits, and list troubleshooting.</p>
        </div>
        <nav class="button-link-list" aria-label="Documentation">
          <a class="button-link" href="https://github.com/joshyidev/simplesiteblock/wiki" target="_blank" rel="noopener">Open documentation</a>
        </nav>
      </div>

      <div class="setting-block setting-block-stack">
        <div class="setting-copy">
          <h3>Bug report</h3>
          <p class="page-desc muted">Report issues to the SimpleSiteBlock issue tracker. Requires a GitHub account.</p>
        </div>
        <nav class="button-link-list" aria-label="Bug report">
          <a class="button-link" href="https://github.com/joshyidev/simplesiteblock/issues" target="_blank" rel="noopener">Open issue tracker</a>
        </nav>
      </div>

      <div class="setting-block setting-block-stack">
        <div class="setting-copy">
          <h3>Check domain</h3>
          <p class="page-desc muted">See whether a domain is blocked, allowed, or not matched.</p>
        </div>
        <div class="row">
          <label class="field">
            <input id="lookupInput" type="text" aria-label="Domain to check" placeholder="example.com or https://example.com">
          </label>
          <button id="lookupButton" class="fit" type="button">Check</button>
        </div>
        <output id="lookupResult" class="verdict">No lookup run.</output>
      </div>
    </div>
  `;
}

function renderAboutTab() {
  return `
    <div class="page about-page">
      <div class="about-panel" aria-label="About ${escapeHtml(manifest.name)}">
        <div class="about-summary">
          <img class="about-icon" src="../../icons/icon128.png" alt="" width="64" height="64">
          <div>
            <p class="about-name">${escapeHtml(manifest.name)}</p>
            <p class="about-version">${escapeHtml(manifest.version)}</p>
            <p class="about-version">Joshua Yi</p>
          </div>
        </div>
      </div>

      <nav class="link-list about-links" aria-label="Links">
        <a href="https://github.com/joshyidev/simplesiteblock" target="_blank" rel="noopener">Source code (MIT)</a>
        <a href="https://github.com/joshyidev/simplesiteblock/releases" target="_blank" rel="noopener">Changelog</a>
        <a href="https://github.com/joshyidev/simplesiteblock/wiki/Privacy-Policy" target="_blank" rel="noopener">Privacy Policy</a>
      </nav>
    </div>
  `;
}

// Reads the blocked-domain count recorded by the worker at rebuild time rather
// than pulling the full dynamic rule set into the page (which spikes memory on
// large lists). Synchronous, so the stats render with the rest of the page.
// Present tense is accurate: every list edit reapplies the slice, so this count
// always describes what is actually enforced.
function statsHtml(state) {
  const domains =
    (state.appliedListDomainCount || 0) + (state.appliedCustomDomainCount || 0);
  const items = [
    `Blocking ${domains.toLocaleString()} domain${domains === 1 ? "" : "s"}`,
    state.lastListUpdateCompletedAt
      ? `Lists checked ${formatCheckedAt(state.lastListUpdateCompletedAt)}`
      : "Lists never checked",
  ];
  // Separator is a middle dot, escaped to keep this file ASCII.
  return escapeHtml(items.join(" \u00b7 "));
}

// Seconds are noise on a weekly update cadence, and the full default format
// crowds the header on narrow windows.
function formatCheckedAt(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Automatic updates run from an alarm with no page open, so a rebuild that fails
// there has no other way to reach the user. The previously applied rules are
// still blocking; what is stale is everything since this error. Tracked per
// slice, since one can fail while the other applies cleanly.
function renderRuleBuildErrors({ lastListBuildError, lastCustomBuildError }) {
  return [
    ["list", lastListBuildError],
    ["custom", lastCustomBuildError],
  ]
    .filter(([, message]) => message)
    .map(
      ([slice, message]) => `
        <p class="build-error-notice" role="status" aria-live="polite">
          Could not apply ${slice} rules: ${escapeHtml(message)} Blocking is still using the last ${slice} rules that applied.
        </p>
      `,
    )
    .join("");
}

function renderPassword(settings) {
  if (!settings.passwordEnabled) {
    return `
      <form id="enablePasswordForm" class="password-form">
        <label class="field">
          New password
          <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
        </label>
        <label class="field">
          Confirm
          <input name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
        </label>
        <div class="password-actions">
          <button class="fit password-submit" type="submit">Enable</button>
          <p class="password-status muted" id="passwordStatus" role="status" aria-live="polite"></p>
        </div>
      </form>
    `;
  }

  return `
    <form id="changePasswordForm" class="password-form">
      <label class="field">
        New password
        <input name="password" type="password" autocomplete="new-password">
      </label>
      <label class="field">
        Confirm
        <input name="confirm" type="password" autocomplete="new-password">
      </label>
      <div class="password-actions">
        <button class="fit password-submit" type="submit">Change</button>
        <p class="password-status muted" id="passwordStatus" role="status" aria-live="polite"></p>
      </div>
    </form>
  `;
}

const DELAY_PRESETS = [
  [0, "Off"],
  [15, "15 seconds"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
];

function renderDelayOptions(current) {
  const selected = Number(current) || 0;
  const presets = DELAY_PRESETS.slice();
  if (!presets.some(([value]) => value === selected)) {
    presets.push([selected, `${selected} seconds`]);
  }
  return presets
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
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
            <th>Entries</th>
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
  const ruleCount = formatRuleCount(list.ruleCount);
  if (list.id === editingListId) {
    return `
      <tr data-list-id="${escapeHtml(list.id)}">
        <td><input class="list-enabled" type="checkbox" ${list.enabled ? "checked" : ""} aria-label="Enabled" disabled></td>
        <td><input class="edit-list-name" type="text" aria-label="List name" value="${escapeHtml(list.name)}"></td>
        <td><input class="edit-list-url" type="url" aria-label="List URL" value="${escapeHtml(list.url)}" required></td>
        <td>${ruleCount}${error}</td>
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
      <td>${ruleCount}${error}</td>
      <td class="actions">
        <button class="edit-list" type="button" ${actionDisabled}>Edit</button>
        <button class="remove-list danger" type="button" ${actionDisabled}>Remove</button>
      </td>
    </tr>
  `;
}

function bindTabs() {
  for (const button of app.querySelectorAll(".tab-button")) {
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.tabId);
    });
  }

  const tablist = app.querySelector(".tabs");
  tablist.addEventListener("keydown", (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;

    const buttons = Array.from(app.querySelectorAll(".tab-button"));
    const currentIndex = buttons.indexOf(document.activeElement);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % buttons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = buttons.length - 1;
    }

    event.preventDefault();
    buttons[nextIndex].focus();
    setActiveTab(buttons[nextIndex].dataset.tabId);
  });
}

function formatRuleCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count > 0
    ? count.toLocaleString()
    : '<span class="muted">—</span>';
}

function setActiveTab(tabId, { updateLocation = true } = {}) {
  if (!isKnownTab(tabId)) return;
  activeTab = tabId;

  for (const button of app.querySelectorAll(".tab-button")) {
    const selected = button.dataset.tabId === tabId;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
  }

  for (const panel of app.querySelectorAll(".tab-panel")) {
    panel.hidden = panel.dataset.tabId !== tabId;
  }

  if (updateLocation) {
    const nextHash = `#${tabId}`;
    if (window.location.hash !== nextHash) {
      history.replaceState(null, "", nextHash);
    }
  }
}

function readActiveTab() {
  const hashTab = window.location.hash.slice(1);
  if (isKnownTab(hashTab)) return hashTab;
  return DEFAULT_TAB;
}

function isKnownTab(tabId) {
  return OPTION_TABS.some((tab) => tab.id === tabId);
}

function bindEvents(state) {
  app
    .querySelector("#addListForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      setListsStatus("Adding and checking list...");
      setIndexControlsDisabled(true);
      try {
        const response = await runBackgroundCommand({
          type: "ssb:add-list",
          name: form.get("name"),
          url: form.get("url"),
        });
        formElement.reset();
        await boot();
        const result = response.result;
        if (result?.error) {
          setListsStatus(`List added, but it has an error: ${result.error}`);
        } else {
          setListsStatus(
            `List added with ${Number(result?.ruleCount || 0).toLocaleString()} entries.`,
          );
        }
      } catch (error) {
        const message = error.message || "Something went wrong.";
        await boot();
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
    .querySelector("#updateInterval")
    .addEventListener("change", async (event) => {
      await saveSettings({ updateIntervalDays: Number(event.target.value) });
      await boot();
      setAutoUpdateStatus("Auto-update interval saved.");
    });

  app.querySelector("#updateAllButton").addEventListener("click", async () => {
    setListsStatus("Updating lists...");
    setIndexControlsDisabled(true);
    try {
      const response = await runBackgroundCommand({
        type: "ssb:update-all-lists",
      });
      await boot();
      setListsStatus(describeUpdateResult(response.result));
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
        const enabled = event.target.checked;
        await runListUiCommand({
          message: {
            type: "ssb:update-list-enabled",
            listId,
            enabled,
          },
          pendingText: "Saving list setting...",
          waitingText: "Waiting for the current list update to finish...",
          successText: enabled ? "List enabled." : "List disabled.",
        });
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
          await runBackgroundCommand({
            type: "ssb:update-list-identity",
            listId,
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
        await runListUiCommand({
          message: { type: "ssb:remove-list", listId },
          pendingText: "Removing list...",
          waitingText: "Waiting for the current list update to finish...",
          successText: "List removed.",
          onSuccess: () => {
            if (editingListId === listId) editingListId = null;
          },
        });
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
      const password = String(form.get("password") || "");
      const confirm = String(form.get("confirm") || "");
      if (password === "" && confirm === "") {
        await saveSettings({ passwordEnabled: false, password: "" });
        if (state.settings.unlockDelaySeconds > 0) {
          sessionStorage.setItem("simpleSiteBlockUnlocked", "true");
        } else {
          lockOptions();
        }
        await boot();
        setPasswordStatus("Password disabled.");
        return;
      }
      if (password !== confirm) {
        setPasswordStatus("Passwords do not match.");
        return;
      }
      if (!isPasswordLongEnough(password)) {
        setPasswordStatus("Password must be at least 8 characters.");
        return;
      }
      await saveSettings({
        password,
      });
      await boot();
      setPasswordStatus("Password changed.");
    });
  }

  const unlockDelayForm = app.querySelector("#unlockDelayForm");
  if (unlockDelayForm) {
    unlockDelayForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const seconds = Number(form.get("unlockDelaySeconds"));
      if (!Number.isInteger(seconds) || seconds < 0) {
        setDelayStatus("Choose a valid delay.");
        return;
      }
      await saveSettings({ unlockDelaySeconds: seconds });
      // Stay unlocked for the current session; the delay applies next session.
      sessionStorage.setItem("simpleSiteBlockUnlocked", "true");
      await boot();
      setDelayStatus(seconds > 0 ? "Unlock delay saved." : "Unlock delay off.");
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
      const gated =
        nextState.settings.passwordEnabled ||
        nextState.settings.unlockDelaySeconds > 0;
      if (gated) {
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

function setAutoUpdateStatus(message) {
  const status = app.querySelector("#autoUpdateStatus");
  if (status) {
    status.textContent = message;
  }
}

// Reports what the update actually did. "All lists updated" was a lie whenever a
// fetch failed; failures point at the row, which carries the specific error.
function describeUpdateResult(summary) {
  if (!summary || typeof summary.checked !== "number") return "Lists updated.";
  if (summary.checked === 0) return "No enabled lists to update.";

  const parts = [`${summary.updated} updated`, `${summary.unchanged} unchanged`];
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  const listWord = summary.checked === 1 ? "list" : "lists";
  const detail =
    summary.failed > 0 ? " — see the failed list below for details." : ".";
  return `Checked ${summary.checked} ${listWord}: ${parts.join(", ")}${detail}`;
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

async function runListUiCommand({
  message,
  pendingText,
  waitingText,
  successText,
  onSuccess,
}) {
  setListsStatus(pendingText);
  setIndexControlsDisabled(true);

  const waitingTimer = setTimeout(() => {
    setListsStatus(waitingText);
  }, 1000);

  try {
    await runBackgroundCommand(message);
    clearTimeout(waitingTimer);
    onSuccess?.();
    await boot();
    setListsStatus(successText);
  } catch (error) {
    clearTimeout(waitingTimer);
    const messageText = error.message || "Something went wrong.";
    await boot();
    setListsStatus(messageText);
    window.alert(messageText);
  } finally {
    clearTimeout(waitingTimer);
    setIndexControlsDisabled(false);
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

function setDelayStatus(message) {
  const delayStatus = app.querySelector("#delayStatus");
  if (delayStatus) {
    delayStatus.textContent = message;
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
