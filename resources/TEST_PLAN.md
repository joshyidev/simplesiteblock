# SimpleSiteBlock User Test Plan

This plan is for manually testing SimpleSiteBlock as a user. It focuses on the
extension's visible behavior: adding rules, blocking pages, managing lists,
using the password lock, and importing or exporting settings.

SimpleSiteBlock is a **top-level site blocker** built on Chrome's
declarativeNetRequest. It blocks top-level navigations (main-frame) to listed
hosts by redirecting them to a block page. It does not block subresources
(scripts, images, iframes), so a blocked host embedded inside another page is
not blocked. It is Chrome-only.

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

3. Open the options page:
   - Click the SimpleSiteBlock toolbar icon.
   - In the popup, click Open options.

## Test Data

Use these custom rules while testing:

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

| Step | Action                           | Expected Result                                                                                                 |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | Install or reload the extension. | The extension loads without browser errors.                                                                     |
| 2    | Click the toolbar icon.          | The popup opens and shows the extension name and version.                                                       |
| 3    | Click Open options.              | The options page opens.                                                                                         |
| 4    | Review the options page.         | Lists, Custom rules, Block page, Password, Import / Export, Diagnostics, Links, and About sections are visible. |

## 2. Custom Rules Blocking (subtree matching)

Matching is subtree: every rule blocks the host **and all its subdomains**.
Plain domains, hosts-file entries, and `||host^` all behave the same way.

| Step | Action                                                                          | Expected Result                                    |
| ---- | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1    | In Custom rules, enter `example.com` and click Save rules.                      | A success message appears.                         |
| 2    | Open `https://example.com`.                                                     | The tab redirects to the block page.               |
| 3    | Open `https://www.example.com`.                                                 | Also blocked — subtree matching covers subdomains. |
| 4    | Replace the rule with <code>&#124;&#124;example.org^</code> and save.           | A success message appears.                         |
| 5    | Open `https://example.org`.                                                     | Blocked.                                           |
| 6    | Open `https://news.example.org`.                                                | The subdomain is blocked.                          |
| 7    | Add <code>@@&#124;&#124;safe.example.org^</code> under the block rule and save. | A success message appears.                         |
| 8    | Open `https://safe.example.org`.                                                | Allowed — the allow rule wins over the block.      |

## 3. Custom Rules Limits And Unsupported Rules

| Step | Action                                                                                              | Expected Result                                                                           |
| ---- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1    | Enter only unsupported rules such as `/ads/`, `*.example.com`, and `example.com/banner`, then Save. | Save is rejected because no valid domains were found.                                     |
| 2    | Enter a valid domain plus some unsupported lines, then Save.                                        | Saves successfully; the unsupported lines are skipped silently and do not block anything. |
| 3    | Paste more than 1000 domains and Save.                                                              | Save is rejected with a message that custom rules are limited to 1000 domains.            |
| 4    | Replace with a small set of valid rules and Save.                                                   | Saves successfully.                                                                       |

## 4. Block Page

| Step | Action                                                                    | Expected Result                                                                                |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | Save a custom rule that blocks `example.com`.                             | A success message appears.                                                                     |
| 2    | Open `https://example.com`.                                               | The tab redirects to the SimpleSiteBlock block page.                                           |
| 3    | Check the block page.                                                     | It shows "This site is blocked" and the block-page message (the default, or your custom text). |
| 4    | In the Block page section, enter a custom message and click Save message. | A success message appears.                                                                     |
| 5    | Open `https://example.com` again.                                         | The block page shows the custom message.                                                       |
| 6    | Clear the Block page message and save.                                    | The block page shows the default message again.                                                |

## 5. Diagnostics

| Step | Action                                                                                            | Expected Result                                                |
| ---- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | Save `example.com` as a custom rule.                                                              | A success message appears.                                     |
| 2    | Enter `example.com` in Diagnostics and click Check.                                               | The verdict says Blocked.                                      |
| 3    | Enter `www.example.com` and click Check.                                                          | The verdict says Blocked — subtree matching covers subdomains. |
| 4    | With the <code>@@&#124;&#124;safe.example.org^</code> allow rule saved, enter `safe.example.org`. | The verdict says Allowed.                                      |
| 5    | Enter a domain not in any rule, e.g. `unrelated.test`.                                            | The verdict says Not blocked.                                  |
| 6    | Enter malformed text such as `not a url ???` or `chrome://extensions`.                            | The UI reports an invalid domain without crashing.             |

## 6. List Management

List edits only mark changes as pending; they take effect when you click Update
All.

| Step | Action                                                          | Expected Result                                                                                                                                    |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Add a list name and a valid list URL.                           | The list appears in the Lists table and the pending notice shows.                                                                                  |
| 2    | Click Update All.                                               | The list fetches, the rule count updates if rules are found, and the pending notice clears. The stats line shows domains blocked and a build time. |
| 3    | Disable the list.                                               | The list stays visible and the pending notice appears.                                                                                             |
| 4    | Click Update All.                                               | Blocking from that list is no longer active.                                                                                                       |
| 5    | Disable the list, then re-enable it before clicking Update All. | The pending notice clears on its own (the net change is zero).                                                                                     |
| 6    | Re-enable a disabled list and click Update All.                 | Blocking from that list becomes active again.                                                                                                      |
| 7    | Rename the list (Edit, change name only, Save).                 | The displayed name changes, no pending notice appears, and cached list data remains usable.                                                        |
| 8    | Edit the list URL and Save.                                     | The pending notice appears and cached data for the old URL no longer applies.                                                                      |
| 9    | Remove the list, then click Update All.                         | The list disappears, and after Update All it no longer affects blocking.                                                                           |

## 7. Auto-Update Setting

| Step | Action                                   | Expected Result                                    |
| ---- | ---------------------------------------- | -------------------------------------------------- |
| 1    | Change Auto-update from Manual to 1 day. | The setting saves.                                 |
| 2    | Reload the options page.                 | The selected interval remains 1 day.               |
| 3    | Change Auto-update back to Manual.       | The setting saves and remains Manual after reload. |

## 8. Password Lock

| Step | Action                                      | Expected Result                                                |
| ---- | ------------------------------------------- | -------------------------------------------------------------- |
| 1    | Enter a password shorter than 8 characters. | The form does not accept it.                                   |
| 2    | Enter two different passwords.              | The UI reports that the passwords do not match.                |
| 3    | Enter and confirm a valid password.         | Password lock is enabled.                                      |
| 4    | Click Lock.                                 | The options page becomes locked.                               |
| 5    | Enter an incorrect password.                | The page remains locked.                                       |
| 6    | Enter the correct password.                 | The options page unlocks.                                      |
| 7    | Change the password.                        | The new password works and the old password no longer unlocks. |
| 8    | Disable the password.                       | The options page no longer requires unlocking.                 |

## 9. Import And Export

| Step | Action                                                                   | Expected Result                                                                                     |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1    | Add custom rules and at least one list.                                  | The options page shows saved custom rules and the list appears in the Lists table.                  |
| 2    | Click Export with Include password settings unchecked.                   | A settings file downloads and does not include password data.                                       |
| 3    | Enable password lock, check Include password settings, and export again. | A settings file downloads with password settings included.                                          |
| 4    | Import a valid exported file.                                            | Lists, custom rules, and settings are restored; imported lists are marked pending until Update All. |
| 5    | Import invalid JSON.                                                     | The UI shows an error and existing settings are not replaced.                                       |

## Final Release Checklist

- Extension installs cleanly in Chrome.
- Popup opens the options page.
- Blocking is top-level only (subresources are not blocked).
- Hosts entries, plain domains, and `||host^` all block the host and its subdomains (subtree).
- Allow rules override block rules; custom rules override list rules.
- Unsupported rules are skipped; a rules box with no valid domains is rejected.
- Custom rules are capped at 1000 domains on both save and import.
- The block page renders the default or custom message.
- Lists can be added, updated, disabled, edited, and removed (changes apply on Update All).
- Password lock can be enabled, unlocked, changed, and disabled.
- Exported settings can be imported successfully.
- Invalid imports fail cleanly.
- The stats line shows domains blocked and the last build time.
