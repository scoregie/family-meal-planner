// Applies the chosen look (colour, font, text size, light or dark) to every page.
// Each page loads this at the end of its <head>, so the look is set before anything is drawn.
//
// There are two layers:
//   - the household's defaults, chosen by an admin on the Settings page (saved on the server), and
//   - this device's own choices (saved in the browser), which win over the household's.
// The household's choice is remembered in the browser too, so pages don't flash the old look
// while it loads.
(function () {
  "use strict";

  // Colour choices. Each has a colour for light mode (white text on it) and one for dark mode
  // (dark text on it). All pass the WCAG AA contrast check against the page and the text on them.
  var COLOURS = {
    green: { name: "Green", light: "#0e6b57", dark: "#52c7a8" },
    teal: { name: "Teal", light: "#0a6375", dark: "#5ccadf" },
    blue: { name: "Blue", light: "#1d5fbf", dark: "#7db1ff" },
    purple: { name: "Purple", light: "#6b3fb8", dark: "#b99cff" },
    berry: { name: "Berry", light: "#a3245e", dark: "#ff8cc0" },
    orange: { name: "Orange", light: "#a04800", dark: "#ffa45e" },
    olive: { name: "Olive", light: "#5a6312", dark: "#c3cf5a" },
    slate: { name: "Slate", light: "#3d4f5c", dark: "#a8bccb" },
  };

  // Fonts. "google" is the Google Fonts name to load; system fonts need nothing loaded.
  var FONTS = {
    atkinson: { name: "Atkinson Hyperlegible", note: "Made to be easy to read", stack: '"Atkinson Hyperlegible",system-ui,sans-serif', google: "Atkinson+Hyperlegible:wght@400;700" },
    lexend: { name: "Lexend", note: "Wide and clear", stack: '"Lexend",system-ui,sans-serif', google: "Lexend:wght@400;700" },
    nunito: { name: "Nunito", note: "Rounded and friendly", stack: '"Nunito",system-ui,sans-serif', google: "Nunito:wght@400;700" },
    literata: { name: "Literata", note: "A book-style serif", stack: '"Literata",Georgia,serif', google: "Literata:opsz,wght@7..72,400;7..72,700" },
    system: { name: "Your device’s font", note: "Loads fastest", stack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' },
  };

  // Text sizes, as a percentage of the browser's normal size (so phone text settings still count).
  var SIZES = {
    small: { name: "Small", scale: 93.75 },
    normal: { name: "Normal", scale: 100 },
    large: { name: "Large", scale: 112.5 },
    larger: { name: "Larger", scale: 125 },
    largest: { name: "Largest", scale: 137.5 },
  };

  var THEMES = { auto: "Match my device", light: "Light", dark: "Dark" };

  var DEFAULTS = { colour: "green", font: "atkinson", size: "normal", theme: "auto" };

  function read(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch (e) {
      return {};
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Private browsing: the choice lasts until the page is closed.
    }
  }

  // Keeps only choices that exist, so an old or broken saved value can't break the page.
  function clean(choice) {
    var out = {};
    if (choice && COLOURS[choice.colour]) out.colour = choice.colour;
    if (choice && FONTS[choice.font]) out.font = choice.font;
    if (choice && SIZES[choice.size]) out.size = choice.size;
    if (choice && THEMES[choice.theme]) out.theme = choice.theme;
    return out;
  }

  // The look to use: defaults, then the household's choices, then this device's.
  function current() {
    var house = clean(read("appearance-house"));
    var mine = clean(read("appearance-mine"));
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = mine[k] || house[k] || DEFAULTS[k];
    });
    return out;
  }

  // Light-mode colours mixed toward white (and dark toward the dark page) for soft backgrounds.
  function vars(c, mode) {
    var accent = mode === "dark" ? c.dark : c.light;
    var card = mode === "dark" ? "#16211d" : "#fff";
    var soft = "color-mix(in srgb," + accent + " " + (mode === "dark" ? 22 : 13) + "%," + card + ")";
    return "--accent:" + accent + ";--mark:" + accent + ";--on-accent:" + (mode === "dark" ? "#0b1210" : "#fff") +
      ";--chip:" + soft + ";--mine:" + soft + ";--drop:" + soft + ";";
  }

  function apply(look) {
    look = look || current();
    var root = document.documentElement;
    if (look.theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", look.theme);

    var colour = COLOURS[look.colour];
    var font = FONTS[look.font];
    var css = "";
    // Only write colours when they differ from the pages' own (green), to keep things simple.
    if (look.colour !== "green") {
      css += ":root{" + vars(colour, "light") + "}" +
        '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){' + vars(colour, "dark") + "}}" +
        ':root[data-theme="dark"]{' + vars(colour, "dark") + "}";
    }
    if (look.font !== "atkinson") css += "body,button,input,select,textarea{font-family:" + font.stack + "}";
    if (look.size !== "normal") css += "html{font-size:" + SIZES[look.size].scale + "%}";

    var style = document.getElementById("appearance-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "appearance-style";
      document.head.appendChild(style);
    }
    style.textContent = css;

    if (font.google && look.font !== "atkinson" && !document.getElementById("font-" + look.font)) {
      var link = document.createElement("link");
      link.id = "font-" + look.font;
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=" + font.google + "&display=swap";
      document.head.appendChild(link);
    }

    // The colour of the phone's status bar.
    var dark = look.theme === "dark" || (look.theme === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute("content", dark ? "#0e1613" : "#f1f5f3");
    });
  }

  apply();

  // Gets the household's choices from the server (not on the login page: that needs a login).
  function refresh() {
    if (/\/login(\.html)?$/.test(location.pathname)) return Promise.resolve();
    return fetch("/api/appearance", { cache: "no-store" }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (got) {
      if (!got) return;
      var before = JSON.stringify(read("appearance-house"));
      write("appearance-house", clean(got.house));
      if (JSON.stringify(read("appearance-house")) !== before) apply();
      return got;
    }).catch(function () { /* offline: keep the remembered look */ });
  }
  refresh();

  // For the Settings page.
  window.Appearance = {
    COLOURS: COLOURS,
    FONTS: FONTS,
    SIZES: SIZES,
    THEMES: THEMES,
    DEFAULTS: DEFAULTS,
    current: current,
    clean: clean,
    house: function () { return clean(read("appearance-house")); },
    mine: function () { return clean(read("appearance-mine")); },
    setMine: function (choice) { write("appearance-mine", clean(choice)); apply(); },
    setHouse: function (choice) { write("appearance-house", clean(choice)); apply(); },
    apply: apply,
    refresh: refresh,
  };
})();
