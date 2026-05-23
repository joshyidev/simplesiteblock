<p align="center">
  <img src="icons/icon256.png" alt="" width="128" height="128">
</p>

<h1 align="center">SimpleSiteBlock</h1>

Like the name suggests, SimpleSiteBlock is a simple site blocker for blocking distracting sites. It can use your own list of sites plus any popular blocklists you want to add.

To open the options page, click the SimpleSiteBlock icon in your browser's toolbar and select Options in the popup.

## Build

```sh
npm run build
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

To run tests:

```sh
npm test
```
