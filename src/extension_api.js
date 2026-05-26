function getExtensionApi() {
  const api = globalThis.chrome;
  if (!api) throw new Error("Extension API is unavailable.");
  return api;
}

export const extensionApi = new Proxy(
  {},
  {
    get(_target, property) {
      return getExtensionApi()[property];
    },
  },
);
