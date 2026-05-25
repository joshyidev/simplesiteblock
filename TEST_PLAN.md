# SimpleSiteBlock User Test Plan

This plan is for manually testing SimpleSiteBlock as a user. It focuses on the
extension's visible behavior: adding rules, blocking pages, managing lists,
using the password lock, and importing or exporting settings.

## Setup

1. Build the extension:

   ```sh
   npm run build
   ```

2. Load the extension in Chrome:
   - Open `chrome://extensions`.
   - Enable Developer mode.
   - Click Load unpacked.
   - Select `dist/chrome`.

3. Optional Firefox check:
   - Open `about:debugging#/runtime/this-firefox`.
   - Click Load Temporary Add-on.
   - Select `dist/firefox/manifest.json`.

4. Open the options page:
   - Click the SimpleSiteBlock toolbar icon.
   - Click Open options.

## Test Data

Use these rules while testing:

```txt
example.com
||example.org^
@@||safe.example.org^
```

Use these URLs while testing:

- `https://example.com`
- `https://www.example.com`
- `https://example.org`
- `https://news.example.org`
- `https://safe.example.org`
- `chrome://extensions`

## 1. First Launch And Popup

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Install or reload the extension. | The extension loads without browser errors. |
| 2 | Click the toolbar icon. | The popup opens and shows the extension name and version. |
| 3 | Click Open options. | The options page opens. |
| 4 | Review the options page. | Lists, custom rules, block action, password, import/export, diagnostics, links, and about sections are visible. |

## 2. Custom Rules Blocking

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | In Custom rules, enter `example.com`. | The rule is visible in the text area. |
| 2 | Click Save rules. | A success message appears. |
| 3 | Open `https://example.com`. | The site is blocked. |
| 4 | Open `https://www.example.com`. | The site is not blocked because plain domains match only the exact host. |
| 5 | Replace the rule with <code>&#124;&#124;example.org^</code> and save. | A success message appears. |
| 6 | Open `https://example.org`. | The site is blocked. |
| 7 | Open `https://news.example.org`. | The subdomain is blocked. |
| 8 | Add <code>@@&#124;&#124;safe.example.org^</code> under the block rule and save. | A success message appears. |
| 9 | Open `https://safe.example.org`. | The site is allowed because the allow rule wins. |

## 3. Unsupported Rule Handling

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Enter unsupported rules such as `/ads/`, `*.example.com`, and `example.com/banner`. | The rules are visible in the text area. |
| 2 | Click Save rules. | The app rejects invalid input or reports warnings for unsupported rules. |
| 3 | Test a matching URL in Diagnostics. | Unsupported rules do not block the URL. |
| 4 | Replace the unsupported rules with valid rules. | Valid rules save successfully. |

## 4. Block Action Modes

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Set Block action to Show blocked page. | The selected block action is saved. |
| 2 | Save a rule that blocks `example.com`. | A success message appears. |
| 3 | Open `https://example.com`. | The tab redirects to the SimpleSiteBlock blocked page. |
| 4 | Check the blocked page. | It shows the blocked URL and rule reason. |
| 5 | Return to options and set Block action to Close tab immediately. | The selected block action is saved. |
| 6 | Open `https://example.com` in a new tab. | The blocked tab closes. |

## 5. Diagnostics

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Save `example.com` as a custom rule. | A success message appears. |
| 2 | Enter `example.com` in Diagnostics and click Test. | The verdict says the URL is blocked. |
| 3 | Enter `www.example.com` and click Test. | The verdict says the URL is allowed. |
| 4 | Enter `chrome://extensions` and click Test. | The verdict says the URL is allowed. |
| 5 | Enter malformed text such as `not a url ???`. | The UI handles it gracefully without crashing. |

## 6. List Management

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Add a list name and a valid list URL. | The list appears in the Lists table. |
| 2 | Confirm the pending notice appears. | The UI says pending changes need Update All. |
| 3 | Click Update All. | The list updates, rule count changes if rules are found, and the pending notice clears. |
| 4 | Disable the list. | The list remains visible and the pending notice appears. |
| 5 | Click Update All. | Blocking from that list is no longer active. |
| 6 | Re-enable the list and click Update All. | Blocking from that list becomes active again. |
| 7 | Rename the list. | The displayed name changes and existing cached list data remains usable. |
| 8 | Edit the list URL. | The list shows pending changes and cached data for the old URL no longer applies. |
| 9 | Remove the list. | The list disappears and no longer affects blocking. |

## 7. Auto-Update Setting

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Change Auto-update from Manual to 1 day. | The setting saves. |
| 2 | Reload the options page. | The selected interval remains 1 day. |
| 3 | Change Auto-update back to Manual. | The setting saves and remains Manual after reload. |

## 8. Password Lock

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Enter a password shorter than 8 characters. | The form does not accept it. |
| 2 | Enter two different passwords. | The UI reports that the passwords do not match. |
| 3 | Enter and confirm a valid password. | Password lock is enabled. |
| 4 | Click Lock. | The options page becomes locked. |
| 5 | Enter an incorrect password. | The page remains locked. |
| 6 | Enter the correct password. | The options page unlocks. |
| 7 | Change the password. | The new password works and the old password no longer unlocks. |
| 8 | Disable the password. | The options page no longer requires unlocking. |

## 9. Import And Export

| Step | Action | Expected Result |
| --- | --- | --- |
| 1 | Add custom rules and at least one list. | The options page shows saved custom rules and the list appears in the Lists table. |
| 2 | Click Export with Include password settings unchecked. | A settings file downloads and does not include password data. |
| 3 | Enable password lock, check Include password settings, and export again. | A settings file downloads with password settings included. |
| 4 | Import a valid exported file. | Settings, lists, custom rules, and block action are restored. |
| 5 | Import invalid JSON. | The UI shows an error and existing settings are not replaced. |
| 6 | Import a backup with invalid custom rules. | The UI shows an error and existing settings are not replaced. |

## 10. Cross-Browser Check

Repeat the core tests in Firefox:

- Open popup and options.
- Save exact and subtree custom rules.
- Confirm blocked page mode works.
- Confirm close-tab mode works.
- Run Diagnostics.
- Export and import settings.

## Final Release Checklist

- Extension installs cleanly in Chrome.
- Extension installs cleanly in Firefox if Firefox support is being released.
- Popup opens the options page.
- Exact rules block only exact hosts.
- Subtree rules block hosts and subdomains.
- Allow rules override block rules.
- Unsupported rules do not create unexpected blocking.
- Blocked page mode shows the correct URL and reason.
- Close-tab mode closes blocked tabs.
- Lists can be added, updated, disabled, edited, and removed.
- Password lock can be enabled, unlocked, changed, and disabled.
- Exported settings can be imported successfully.
- Invalid imports fail cleanly.
