(function () {
  var root = document.documentElement;
  var cacheKey = "simpleSiteBlockTheme";

  function normalize(theme) {
    return theme === "light" || theme === "dark" || theme === "system"
      ? theme
      : "system";
  }

  function cache(theme) {
    try {
      localStorage.setItem(cacheKey, theme);
    } catch {
      // Storage can be unavailable in unusual contexts; theme still applies.
    }
  }

  function apply(theme) {
    var normalized = normalize(theme);
    if (normalized === "light" || normalized === "dark") {
      root.dataset.theme = normalized;
    } else {
      root.removeAttribute("data-theme");
    }
    root.style.visibility = "";
    cache(normalized);
  }

  try {
    var cachedTheme = localStorage.getItem(cacheKey);
    if (cachedTheme) {
      apply(cachedTheme);
      return;
    }
  } catch {
    // Fall back to storage below.
  }

  if (!chrome.storage?.local) {
    apply("system");
    return;
  }

  root.style.visibility = "hidden";
  chrome.storage.local.get({ settings: { theme: "system" } }, function (stored) {
    apply(stored.settings?.theme);
  });
}());
