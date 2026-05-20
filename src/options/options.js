import { evaluate, hydrateIndex } from "../background/engine.js";
import { hashPassword, verifyPassword } from "../background/crypto.js";
import {
  addList,
  removeList,
  updateAllLists,
  updateCustomRules,
  updateListSettings,
} from "../background/lists.js";
import {
  getState,
  getStorageBytesInUse,
  saveSettings,
} from "../background/storage.js";
import { isOptionsUnlocked, lockOptions, renderLock } from "./lock.js";

const app = document.querySelector("#app");
const lock = document.querySelector("#lock");
const status = document.querySelector("#status");
const lockButton = document.querySelector("#lockButton");

void boot();

async function boot() {
  const state = await getState();
  if (!isOptionsUnlocked(state.settings)) {
    app.hidden = true;
    lockButton.hidden = true;
    renderLock(lock, {
      verifyPassword,
      settings: state.settings,
      setStatus,
      onUnlocked: () => void boot(),
    });
    return;
  }

  lock.hidden = true;
  app.hidden = false;
  lockButton.hidden = !state.settings.passwordEnabled;
  renderApp(state);
}

function renderApp(state) {
  const bytesPromise = getStorageBytesInUse();
  const totalRules = countRules(state.compiledIndex);

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
        ${state.pendingRebuild ? '<p class="pending-notice">Pending changes — run <strong>Update All</strong> to apply.</p>' : ""}
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
          <button class="fit" type="submit">Add list</button>
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
            <button class="fit" type="submit">Save rules</button>
            <p class="custom-rules-status muted" id="customRulesStatus" role="status" aria-live="polite"></p>
          </div>
        </form>
      </section>

      <section class="panel">
        <h2>Block action</h2>
        <div class="choice" id="blockActionChoices">
          <label><input type="radio" name="blockAction" value="show_block_page" ${state.settings.blockAction === "show_block_page" ? "checked" : ""}> Show block page</label>
          <label><input type="radio" name="blockAction" value="close_tab" ${state.settings.blockAction === "close_tab" ? "checked" : ""}> Close tab</label>
        </div>
      </section>

      <section class="panel">
        <h2>Password</h2>
        ${renderPassword(state.settings)}
      </section>

      <section class="panel span">
        <h2>Diagnostics</h2>
        <div class="row">
          <label class="field">
            Test URL
            <input id="testUrl" type="text" placeholder="example.com or https://example.com">
          </label>
          <button id="testUrlButton" class="fit" type="button">Test</button>
          <output id="testVerdict" class="verdict">No test run.</output>
        </div>
        <p class="muted" id="diagStats">Storage: calculating...</p>
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

  bytesPromise.then((bytes) => {
    const stats = app.querySelector("#diagStats");
    if (stats) {
      stats.textContent = `Storage: ${formatBytes(bytes)}`;
    }
  });

  bindEvents(state);
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
        <button class="fit" type="submit">Enable</button>
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
      <button class="fit" type="submit">Change</button>
    </form>
    <form id="disablePasswordForm" class="row">
      <button class="danger fit" type="submit">Disable</button>
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
      setStatus("Block action saved.");
    });

  app
    .querySelector("#addListForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      await runBusy("Adding list...", async () => {
        await addList({
          name: form.get("name"),
          url: form.get("url"),
        });
        formElement.reset();
        await boot();
        setStatus("List added.");
      });
    });

  app
    .querySelector("#customRulesForm")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setCustomRulesStatus("Saving custom rules...");
      try {
        await updateCustomRules(form.get("customRules"));
        await boot();
        setCustomRulesStatus("Custom rules saved.");
      } catch (error) {
        const message = error.message || "Something went wrong.";
        setCustomRulesStatus(message);
        window.alert(message);
      }
    });

  app.querySelector("#updateInterval").addEventListener("change", async (event) => {
    await saveSettings({ updateIntervalDays: Number(event.target.value) });
    setStatus("Auto-update interval saved.");
  });

  app.querySelector("#updateAllButton").addEventListener("click", async () => {
    setListsStatus("Updating lists...");
    try {
      await updateAllLists();
      await boot();
      setListsStatus("All lists updated.");
    } catch (error) {
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
        setStatus("List setting saved.");
      });
    row.querySelector(".remove-list").addEventListener("click", async () => {
      await removeList(listId);
      await boot();
      setStatus("List removed.");
    });
  }

  const enableForm = app.querySelector("#enablePasswordForm");
  if (enableForm) {
    enableForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = form.get("password");
      if (password !== form.get("confirm")) {
        setStatus("Passwords do not match.");
        return;
      }
      await saveSettings({
        passwordEnabled: true,
        passwordHash: await hashPassword(password),
      });
      sessionStorage.setItem("simpleSiteBlockUnlocked", "true");
      await boot();
      setStatus("Password enabled.");
    });
  }

  const changeForm = app.querySelector("#changePasswordForm");
  if (changeForm) {
    changeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const password = form.get("password");
      if (password !== form.get("confirm")) {
        setStatus("Passwords do not match.");
        return;
      }
      await saveSettings({
        passwordHash: await hashPassword(password),
      });
      await boot();
      setStatus("Password changed.");
    });
  }

  const disableForm = app.querySelector("#disablePasswordForm");
  if (disableForm) {
    disableForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveSettings({ passwordEnabled: false, passwordHash: null });
      lockOptions();
      await boot();
      setStatus("Password disabled.");
    });
  }

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
  });
}

lockButton.addEventListener("click", () => {
  lockOptions();
  void boot();
});

async function runBusy(message, task) {
  setStatus(message);
  try {
    await task();
  } catch (error) {
    const message = error.message || "Something went wrong.";
    setStatus(message);
    window.alert(message);
  }
}

function setStatus(message) {
  status.textContent = message;
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

function formatBytes(bytes) {
  if (bytes == null) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
