# SimpleSiteBlock

SimpleSiteBlock is a Manifest V3 Chrome extension that blocks top-level navigations using hosts-file and a practical subset of Adblock Plus filter lists.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository folder.

## Notes

- Blocking uses `chrome.webNavigation.onBeforeNavigate` and redirects or closes top-level tabs after navigation is observed. It is not a low-level network cancellation API.
- The password lock is a soft options-page gate. It helps prevent casual tampering, but anyone with access to the Chrome profile on disk can read or clear extension storage, disable the extension, or uninstall it.
- If you forget the options password, clear the extension's local storage from extension devtools or uninstall and reinstall the extension.
- Lists are stored in `chrome.storage.local`; large lists are supported through the `unlimitedStorage` permission.

## Development

Run the pure parser and engine tests:

```sh
npm test
```
