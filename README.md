<p align="center">
  <img src="icons/icon256.png" alt="" width="128" height="128">
</p>

<h1 align="center">SimpleSiteBlock</h1>

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

## Development

Run the pure parser and engine tests:

```sh
npm test
```
