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

  // Fonts. All four are served from site/fonts/ (fonts/fonts.css, linked by every page), so no page contacts Google.
  var FONTS = {
    atkinson: { name: "Atkinson Hyperlegible", note: "Made to be easy to read", stack: '"Atkinson Hyperlegible",system-ui,sans-serif' },
    lexend: { name: "Lexend", note: "Wide and clear", stack: '"Lexend",system-ui,sans-serif' },
    nunito: { name: "Nunito", note: "Rounded and friendly", stack: '"Nunito",system-ui,sans-serif' },
    literata: { name: "Literata", note: "A book-style serif", stack: '"Literata",Georgia,serif' },
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

  // The household's country (chosen by the owner) sets the currency, number and date style, the
  // energy unit to start with and which grocery stores are offered. The data is in regions.js.
  var R = window.REGIONS || { countries: {}, stores: {} };
  // The household's country id, like "au" (remembered from the server; Australia if not known yet).
  function country() {
    var c = read("country").id;
    return R.countries[c] ? c : "au";
  }
  // The household's country with its details from regions.js (name, currency, locale, energy, stores).
  function region() {
    return R.countries[country()] || { name: "Australia", currency: "AUD", locale: "en-AU", energy: "kJ", guidelines: "au", stores: ["coles"] };
  }
  // For dates and numbers: English, with the country's conventions ("en-GB", "en-DE"...).
  function locale() {
    return region().locale;
  }
  // An amount of money. Plan prices are in the plan's currency (AUD unless the plan says
  // otherwise), so it is labelled with that: "$12.50" in Australia, "A$12.50" elsewhere.
  function money(n, currency, whole) {
    try {
      return new Intl.NumberFormat(locale(), { style: "currency", currency: currency || "AUD", maximumFractionDigits: whole ? 0 : undefined, minimumFractionDigits: whole ? 0 : undefined }).format(+n || 0);
    } catch (e) {
      return "$" + (+n || 0).toFixed(whole ? 0 : 2);
    }
  }

  // Grocery stores. Some have a search page we can link to directly. Others run their online
  // shops store by store with no shared search address, so their links search the store's
  // website on Google instead. In-store-only shops have no link.
  function siteSearch(site) {
    return function (q) { return "https://www.google.com/search?q=" + encodeURIComponent("site:" + site + " " + q); };
  }
  // A store's search link maker from its address pattern: {q} is replaced by the item's name.
  function template(t) {
    return function (q) { return t.replace("{q}", encodeURIComponent(q)); };
  }
  var STORES = {};
  Object.keys(R.stores).forEach(function (k) {
    var s = R.stores[k];
    STORES[k] = { name: s.name, short: s.short, note: s.note, search: s.search ? template(s.search) : s.site ? siteSearch(s.site) : null };
  });
  // The stores offered in this household's country.
  function countryStores() {
    return region().stores.filter(function (k) { return STORES[k]; });
  }
  // Without a choice: the country's first store with a search link.
  function defaultStores() {
    var list = countryStores();
    var linked = list.filter(function (k) { return STORES[k].search; });
    return (linked.length ? linked : list).slice(0, 1);
  }

  // A list of store ids with unknown ones and repeats removed.
  function cleanStores(list) {
    return Array.isArray(list) ? list.filter(function (k, i) { return STORES[k] && list.indexOf(k) === i; }) : [];
  }

  // The stores to show: this person's choice, else the household's, else the country's first.
  function stores() {
    var saved = read("stores");
    var here = countryStores();
    var mine = cleanStores(saved.mine).filter(function (k) { return here.indexOf(k) >= 0; });
    var house = cleanStores(saved.house).filter(function (k) { return here.indexOf(k) >= 0; });
    return mine.length ? mine : house.length ? house : defaultStores();
  }

  // Energy units: kilojoules or Calories. The plan stores kJ; this only changes what's shown.
  var ENERGY = { kJ: { name: "Kilojoules (kJ)", short: "kJ" }, kcal: { name: "Calories (kcal)", short: "kcal" } };
  // The energy units chosen: {mine: this person's, house: the household's} ('' = not chosen).
  function energyChoices() {
    var e = read("energy");
    return { mine: ENERGY[e.mine] ? e.mine : "", house: ENERGY[e.house] ? e.house : "" };
  }
  // The energy unit to show: your own choice, else the household's, else the country's usual one.
  function energyUnit() {
    var c = energyChoices();
    return c.mine || c.house || region().energy || "kJ";
  }
  // A kJ amount as a number in the chosen unit.
  function energyValue(kj) {
    return energyUnit() === "kcal" ? kj / 4.184 : kj;
  }
  // A kJ amount as text in the chosen unit: "1,234 kJ" or "295 kcal".
  function energyText(kj) {
    return Math.round(energyValue(kj)).toLocaleString(locale()) + " " + energyUnit();
  }

  var DEFAULTS = { colour: "green", font: "atkinson", size: "normal", theme: "auto" };

  // Reads a saved choice from the browser's storage (an empty object if there isn't one).
  function read(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch (e) {
      return {};
    }
  }

  // Saves a choice in the browser's storage.
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
    var card = mode === "dark" ? "#1c1c1f" : "#fff";
    var soft = "color-mix(in srgb," + accent + " " + (mode === "dark" ? 22 : 13) + "%," + card + ")";
    return "--accent:" + accent + ";--mark:" + accent + ";--on-accent:" + (mode === "dark" ? "#0b1210" : "#fff") +
      ";--chip:" + soft + ";--mine:" + soft + ";--drop:" + soft + ";";
  }

  // Puts a look on the page: light or dark, colour, font and text size, plus the phone's status bar
  // colour. It does this by writing a few CSS rules into a <style> element.
  function apply(look) {
    look = look || current();
    var root = document.documentElement;
    root.setAttribute("lang", locale());
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

    // The colour of the phone's status bar.
    var dark = look.theme === "dark" || (look.theme === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute("content", dark ? "#121214" : "#f5f5f4");
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
      if (got.pins) {
        var beforePins = JSON.stringify(read("pins"));
        write("pins", got.pins);
        if (JSON.stringify(got.pins) !== beforePins) window.dispatchEvent(new Event("stores-changed"));
      }
      if (got.energy) {
        var beforeEnergy = JSON.stringify(read("energy"));
        write("energy", got.energy);
        if (JSON.stringify(got.energy) !== beforeEnergy) window.dispatchEvent(new Event("units-changed"));
      }
      if (got.country) {
        var beforeCountry = read("country").id;
        write("country", { id: got.country });
        if (got.country !== beforeCountry) {
          window.dispatchEvent(new Event("units-changed"));
          window.dispatchEvent(new Event("stores-changed"));
        }
      }
      if (got.stores) {
        var beforeStores = JSON.stringify(read("stores"));
        write("stores", got.stores);
        // Pages that show store links (the shopping list) redraw when the choice changes.
        if (JSON.stringify(got.stores) !== beforeStores) window.dispatchEvent(new Event("stores-changed"));
      }
      return got;
    }).catch(function () { /* offline: keep the remembered look */ });
  }
  refresh();

  // A person's key from their name, the same way as the server (toKey in api/server.js).
  function personKey(name) {
    var key = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    var letter;
    try { letter = new RegExp("[\\p{L}\\p{N}]", "u"); } catch (e) { letter = /\S/; }
    if (/[a-z0-9]/.test(key) || !letter.test(String(name || ""))) return key;
    var h = 0x811c9dc5;
    var s = String(name).trim();
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return "p-" + ("0000000" + h.toString(16)).slice(-8);
  }

  // For the Settings page.
  window.Appearance = {
    personKey: personKey,
    COLOURS: COLOURS,
    FONTS: FONTS,
    SIZES: SIZES,
    THEMES: THEMES,
    STORES: STORES,
    DEFAULTS: DEFAULTS,
    stores: stores,
    REGIONS: R,
    country: country,
    region: region,
    setCountry: function (id) { write("country", { id: id }); window.dispatchEvent(new Event("units-changed")); window.dispatchEvent(new Event("stores-changed")); },
    locale: locale,
    money: money,
    countryStores: countryStores,
    defaultStores: defaultStores,
    ENERGY: ENERGY,
    // Pinned product pages: {item name: {store: url}}.
    pins: function () { return read("pins"); },
    setPins: function (p) { write("pins", p || {}); },
    energyUnit: energyUnit,
    energyValue: energyValue,
    energyText: energyText,
    energyChoices: energyChoices,
    setEnergy: function (choices) { write("energy", choices); window.dispatchEvent(new Event("units-changed")); },
    storeChoices: function () {
      var s = read("stores");
      var here = countryStores();
      var only = function (l) { return cleanStores(l).filter(function (k) { return here.indexOf(k) >= 0; }); };
      return { mine: only(s.mine), house: only(s.house) };
    },
    setStores: function (choices) { write("stores", { mine: cleanStores(choices.mine), house: cleanStores(choices.house) }); window.dispatchEvent(new Event("stores-changed")); },
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
