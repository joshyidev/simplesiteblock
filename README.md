# SimpleSiteBlock

SimpleSiteBlock is a Manifest V3 browser extension that blocks top-level navigations using hosts-file and a practical subset of Adblock Plus filter lists.

## Build

```sh
npm run build:chrome
npm run build:firefox
```

Chrome output is written to `dist/chrome`. Firefox output is written to `dist/firefox`.

## Load locally

### Chrome

1. Run `npm run build:chrome`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `dist/chrome`.

### Firefox

1. Run `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `dist/firefox/manifest.json`.

## Notes

- Blocking uses `webNavigation.onBeforeNavigate` and redirects or closes top-level tabs after navigation is observed. It is not a low-level network cancellation API.
- The password lock is a soft options-page gate. It helps prevent casual tampering, but anyone with access to the Chrome profile on disk can read or clear extension storage, disable the extension, or uninstall it.
- If you forget the options password, clear the extension's local storage from extension devtools or uninstall and reinstall the extension.
- Lists are stored in extension local storage; large lists are supported through the `unlimitedStorage` permission.

## Development

Run the pure parser and engine tests:

```sh
npm test
```
