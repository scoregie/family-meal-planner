// The main app page, part 2 of 6: the Shopping tab. The shopping lists, ticks, "At home" marks and
// shop mode (one item at a time). app-core.js lists all six parts.

// ---------- shopping items ----------

// Strips sizes and counts from an item name to get something to search for:
// "Turkey mince 500 g × 2" becomes "Turkey mince". The same name marks an item "At home".
function query(name) {
  return name
    .replace(/\(.*?\)/g, " ")                    // anything in brackets
    .replace(/[×~]/g, " ")                       // × and ~
    .replace(/\d+\s*-?\s*pack/gi, " ")           // "12-pack"
    .replace(/\d+(\.\d+)?\s*(kg|g|ml|l)\b/gi, " ") // "500 g", "2 L"
    .replace(/\b\d+\b/g, " ")                    // other numbers
    .replace(/\b(jar|sachet)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Links to search the person's chosen stores for an item (the country's first store unless they picked others in
// Settings). Stores with no online shop (Aldi) get no link.
// A pinned product goes straight to that product page instead of a search.
function storeLinks(name) {
  var A = window.Appearance;
  var picked = pinStores();
  var pinned = pinsFor(name);
  var links = [];
  picked.forEach(function (k) {
    var store = A.STORES[k];
    var pin = pinned[k];
    var a = el("a", "find" + (pin ? " pinned" : ""), pin ? (picked.length === 1 ? "Open in " + store.name : store.short + " ★") : (picked.length === 1 ? "Search " + store.name : store.short));
    a.href = pin || store.search(query(name));
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", pin ? "Open your pinned " + store.name + " product for " + name : "Search " + store.name + " for " + name);
    links.push(a);
  });
  return links;
}

// The person's stores that have a website (so links and pins work there).
function pinStores() {
  var A = window.Appearance;
  return A ? A.stores().filter(function (k) { return A.STORES[k].search; }) : [];
}

// The pinned product pages for an item: {coles: url, ...}. Pins are kept by the simplified name,
// so "Turkey mince 500 g" and "Turkey mince 1 kg" share one.
function pinsFor(name) {
  var all = window.Appearance && Appearance.pins ? Appearance.pins() : {};
  var key = query(name).toLowerCase();
  var mine = all && Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  return mine && typeof mine === "object" ? mine : {};
}

// A "Pin product" button for an item, or null if the person's stores have no website.
function pinButton(name) {
  if (!pinStores().length) return null;
  var has = Object.keys(pinsFor(name)).length > 0;
  var b = el("button", "pinbtn", has ? "★ Pinned" : "Pin product");
  b.type = "button";
  b.setAttribute("aria-label", (has ? "Change the pinned product for " : "Pin a product for ") + name);
  b.onclick = function () { openPin(name); };
  return b;
}

// The "Pin a product" box: paste a product page for each store.
function openPin(name) {
  var A = window.Appearance;
  var dlg = $("pinDlg");
  var pinned = pinsFor(name);
  var stores = pinStores();
  $("pinName").textContent = query(name);
  $("pinMsg").textContent = "";
  var fields = $("pinFields");
  fields.textContent = "";
  stores.forEach(function (k) {
    var lab = el("label", "pinfield");
    lab.appendChild(el("span", "", A.STORES[k].name + " product page"));
    var input = el("input");
    input.type = "url";
    input.inputMode = "url";
    input.autocomplete = "off";
    input.placeholder = "https://…";
    input.value = pinned[k] || "";
    input.dataset.store = k;
    lab.appendChild(input);
    var find = el("a", "find", "Find it on " + A.STORES[k].name);
    find.href = A.STORES[k].search(query(name));
    find.target = "_blank";
    find.rel = "noopener noreferrer";
    lab.appendChild(find);
    fields.appendChild(lab);
  });
  $("pinSave").onclick = function () { savePins(name, false); };
  $("pinRemove").hidden = !Object.keys(pinned).length;
  $("pinRemove").onclick = function () { savePins(name, true); };
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
}

// Saves (or, with `remove`, clears) the pins typed into the box, one store at a time.
function savePins(name, remove) {
  var pinned = pinsFor(name);
  var changes = [];
  $("pinFields").querySelectorAll("input").forEach(function (input) {
    var v = remove ? "" : input.value.trim();
    if (v !== (pinned[input.dataset.store] || "")) changes.push({ store: input.dataset.store, url: v });
  });
  var item = query(name).toLowerCase();
  var chain = Promise.resolve(null);
  changes.forEach(function (c) {
    chain = chain.then(function () {
      return fetch("/api/appearance/pins", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "app" },
        body: JSON.stringify({ item: item, store: c.store, url: c.url }),
        cache: "no-store",
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || "That didn’t save. Try again.");
          if (j.pins) Appearance.setPins(j.pins);   // so a later failure still shows what did save
          return j;
        });
      });
    });
  });
  $("pinMsg").textContent = changes.length ? "Saving…" : "";
  chain.then(function (last) {
    if (last && last.pins) Appearance.setPins(last.pins);
    closePin();
    if (PLAN) show();
    if (SHOP) shopDraw();
  }).catch(function (e) {
    $("pinMsg").textContent = e.message;
    if (PLAN) show();
  });
}

// Closes the "pin a product page" box.
function closePin() {
  var dlg = $("pinDlg");
  if (dlg.close) dlg.close(); else dlg.removeAttribute("open");
}

// True if an item is marked "At home".
function isHome(name) {
  return have.indexOf(query(name).toLowerCase()) > -1;
}

// The stock-up week (pantry and freezer, bought every 2 weeks) that is shopped with a meal week:
// the stock-up just before it. -1 if there isn't one.
function stockFor(weekIndex) {
  var before = PLAN.weeks[weekIndex - 1];
  return before && before.kind === "stockup" && PLAN.weeks[weekIndex].kind !== "stockup" ? weekIndex - 1 : -1;
}

// Which part of the list is shown when a week includes a stock-up: "all", "week" or "stock".
var shopPart = lsGet("coles-plan-shop-part") || "all";

// The aisles the list is grouped by, in the order most people walk a supermarket.
var CATS = [
  ["fresh", "Fruit and veg"],
  ["protein", "Meat, fish and eggs"],
  ["dairy", "Dairy and fridge"],
  ["bakery", "Bread and wraps"],
  ["frozen", "Frozen"],
  ["pantry", "Pantry"],
  ["other", "Other"],
];

// The aisle for an item, from its name and the plan section it is in.
function catOf(name, section) {
  var n = name.toLowerCase();
  var s = section.toLowerCase();
  if (/freez|frozen/.test(s) || /^frozen\b/.test(n)) return "frozen";
  if (/\beggs?\b/.test(n) && !/noodle/.test(n)) return "protein";
  if (/meat|fish|seafood|poultry|protein/.test(s)) return "protein";
  if (/fruit|veg|produce/.test(s)) return "fresh";
  if (/\b(bread|wraps?|rolls?|pita|tortillas?|bagels?|crumpets?)\b/.test(n) && !/crumbs/.test(n)) return "bakery";
  if (/dairy|fridge|chill/.test(s)) return "dairy";
  if (/pantry|cupboard|top-up/.test(s)) return "pantry";
  return "other";
}

// Every item on a week's list: {name, price, src (the plan week it comes from), id ("section-item",
// how its tick is saved), cat, stock (true for stock-up items)}. `part` picks all, the week only,
// or the stock-up only.
function shopItems(weekIndex, part) {
  var sources = [];
  var stock = stockFor(weekIndex);
  if (part !== "stock" || stock < 0) sources.push(weekIndex);
  if (stock > -1 && part !== "week") sources.push(stock);
  var out = [];
  sources.forEach(function (src) {
    var shopping = PLAN.weeks[src].shopping;
    Object.keys(shopping).forEach(function (section, sectionIndex) {
      shopping[section].forEach(function (item, itemIndex) {
        out.push({
          name: item[0],
          price: item[1],
          src: src,
          id: sectionIndex + "-" + itemIndex,
          cat: catOf(item[0], section),
          stock: PLAN.weeks[src].kind === "stockup",
        });
      });
    });
  });
  return out;
}

// The items shown now, grouped by aisle: [[aisle name, items], ...], leaving out empty aisles.
function grouped(items) {
  return CATS.map(function (cat) {
    var inCat = items.filter(function (it) { return it.cat === cat[0]; });
    inCat.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return [cat[1], inCat];
  }).filter(function (g) { return g[1].length; });
}

// True if a shopping item is ticked off.
function isTicked(it) {
  return (ticks[it.src] || []).indexOf(it.id) > -1;
}

// A week's total (with its stock-up), leaving out anything marked "At home".
function total(weekIndex) {
  var sum = 0;
  shopItems(weekIndex, "all").forEach(function (it) {
    if (!isHome(it.name)) sum += it.price;
  });
  return sum;
}

// Checks plan.json has the shape the page needs. Returns "" if it is fine, or a message
// saying what is wrong (shown in red at the top of the page).
function validate(p) {
  if (!p || !Array.isArray(p.weeks) || !p.weeks.length) return "It needs a non-empty \"weeks\" list.";
  for (var i = 0; i < p.weeks.length; i++) {
    var w = p.weeks[i];
    var where = "Week " + (i + 1) + ": ";
    if (!w || typeof w.shopping !== "object" || w.shopping === null || Array.isArray(w.shopping)) {
      return where + "\"shopping\" must be an object of sections.";
    }
    var names = Object.keys(w.shopping);
    if (!names.length) return where + "\"shopping\" has no sections.";
    for (var k = 0; k < names.length; k++) {
      var items = w.shopping[names[k]];
      if (!Array.isArray(items)) return where + "section \"" + names[k] + "\" must be a list.";
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        if (!Array.isArray(item) || typeof item[0] !== "string" || typeof item[1] !== "number") {
          return where + "each item in \"" + names[k] + "\" must look like [\"Name\", 1.5] (item " + (j + 1) + ").";
        }
      }
    }
    if (w.meals && !Array.isArray(w.meals)) return where + "\"meals\" must be a list.";
    if (w.recipes && !Array.isArray(w.recipes)) return where + "\"recipes\" must be a list.";
    if (w.exercise) {
      if (typeof w.exercise !== "object") return where + "\"exercise\" must be an object.";
      // One plan for everyone ({days}) or one per person ({you: {days}, ...}).
      var plans = Array.isArray(w.exercise.days)
        ? [w.exercise]
        : Object.keys(w.exercise).map(function (key) { return w.exercise[key]; });
      for (var b = 0; b < plans.length; b++) {
        if (!plans[b] || !Array.isArray(plans[b].days)) return where + "each \"exercise\" plan needs a \"days\" list.";
      }
    }
  }
  return "";
}

// ---------- the shopping list ----------

// Draws the shopping list for the current week, grouped by aisle. Weeks that start a fortnight
// include the 2-week stock-up (pantry and freezer), and the buttons above the list show it all,
// just this week's fresh food, or just the stock-up. Each item has a tick box, its price, links
// to search the chosen stores, an "At home?" button and who ticked it.
function renderList() {
  var box = $("lists");
  box.textContent = "";
  box.className = hideDone ? "hide-done" : "";

  var partBox = $("shopPart");
  partBox.textContent = "";
  var hasStock = stockFor(week) > -1;
  partBox.hidden = !hasStock;
  if (hasStock) {
    [["all", "Everything"], ["week", "This week"], ["stock", "2-week stock-up"]].forEach(function (option) {
      var b = el("button", "btn", option[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", shopPart === option[0]);
      b.onclick = function () {
        shopPart = option[0];
        try { localStorage.setItem("coles-plan-shop-part", shopPart); } catch (e) {}
        renderList();
      };
      partBox.appendChild(b);
    });
  }

  grouped(shopItems(week, hasStock ? shopPart : "all")).forEach(function (group) {
    var sectionEl = el("section");
    var heading = el("h2", null, group[0]);
    var subtotal = 0;
    group[1].forEach(function (it) {
      if (!isHome(it.name)) subtotal += it.price;
    });
    heading.appendChild(el("small", null, money(subtotal)));
    sectionEl.appendChild(heading);
    var list = el("ul");
    group[1].forEach(function (it) {
      list.appendChild(shopItem(it, hasStock && shopPart === "all"));
    });
    sectionEl.appendChild(list);
    box.appendChild(sectionEl);
  });
  // "Use it up": fresh food the plan expects to be left at the end of this week.
  var useUp = PLAN.weeks[week] && PLAN.weeks[week].useUp;
  if (Array.isArray(useUp) && useUp.length && shopPart !== "stock") {
    var left = el("section");
    left.appendChild(el("h2", null, "Likely left over this week"));
    left.appendChild(el("p", "note2", "The week’s meals don’t use all of these. Use them in a lunch or a snack, freeze what freezes (meat, bread), or buy a smaller pack if your shop has one."));
    var leftList = el("ul", "bul");
    useUp.forEach(function (text) { leftList.appendChild(el("li", null, String(text).charAt(0).toUpperCase() + String(text).slice(1))); });
    left.appendChild(leftList);
    box.appendChild(left);
  }
  refreshBylines();
  updateSummary();
}

// One shopping item. Its tick is saved under the plan week it comes from and its position
// there ("section-item"). `tagStock` adds a small "Stock-up" tag to stock-up items.
function shopItem(it, tagStock) {
  var name = it.name;
  var home = isHome(name);
  var ticked = isTicked(it);
  var row = el("li", (ticked ? "done " : "") + (home ? "home" : ""));

  var label = el("label", "row");
  var box = el("input");
  box.type = "checkbox";
  box.checked = ticked;
  box.onchange = function () { toggle(it, box.checked, row); };
  label.appendChild(box);
  label.appendChild(el("span", "box"));   // the drawn tick box
  var nameEl = el("span", "name", name);
  if (tagStock && it.stock) nameEl.appendChild(el("span", "stocktag", "Stock-up"));
  label.appendChild(nameEl);
  label.appendChild(el("span", "price", money(it.price)));

  var links = storeLinks(name);

  var homeButton = el("button", "homebtn", home ? "✓ At home" : "At home?");
  homeButton.type = "button";
  homeButton.setAttribute("aria-pressed", home);
  homeButton.setAttribute("aria-label", (home ? "Remove from at home: " : "Mark as at home: ") + name);
  homeButton.onclick = function () { toggleHome(name); };

  var byline = el("span", "byline");   // "Ticked by Sam · Sat 8 Nov, 5:02 pm"
  byline.dataset.k = it.src + "|" + it.id;

  var actions = el("div", "acts");
  if (links.length > 1) actions.appendChild(el("span", "findlab", "Search"));
  links.forEach(function (a) { actions.appendChild(a); });
  actions.appendChild(homeButton);
  var pin = pinButton(name);
  if (pin) actions.appendChild(pin);
  actions.appendChild(byline);
  row.appendChild(label);
  row.appendChild(actions);
  return row;
}

// "Ticked by Sam · Sat 8 Nov, 5:02 pm" for one item, or "" if nobody is recorded.
function byText(key) {
  var by = BY[key];
  if (!by) return "";
  var d = new Date(by.at);
  var whenText = isNaN(d)
    ? ""
    : " · " + d.toLocaleDateString(Appearance.locale(), { weekday: "short", day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString(Appearance.locale(), { hour: "numeric", minute: "2-digit" });
  return "Ticked by " + nameOf(by.who) + whenText;
}

// Updates every "Ticked by" line without redrawing the list.
function refreshBylines() {
  document.querySelectorAll("#lists .byline").forEach(function (line) {
    var parts = line.dataset.k.split("|");
    line.textContent = (ticks[parts[0]] || []).indexOf(parts[1]) > -1 ? byText(line.dataset.k) : "";
  });
}

// ---------- shopping ticks and "At home" ----------

// Ticks or unticks a shopping item, and records who ticked it.
function toggle(it, on, row) {
  var list = ticks[it.src] || [];
  var at = list.indexOf(it.id);
  if (on && at < 0) list.push(it.id);
  if (!on && at > -1) list.splice(at, 1);
  ticks[it.src] = list;
  var key = it.src + "|" + it.id;
  if (on) {
    if (ME) BY[key] = { who: ME.person, at: Date.now() };
  } else {
    delete BY[key];
  }
  refreshBylines();
  save();
  row.className = (on ? "done " : "") + (row.className.indexOf("home") > -1 ? "home" : "");
  updateSummary();
}

// Marks an item "At home" (or not). It is remembered by its simplified name, in every week.
function toggleHome(name) {
  var key = query(name).toLowerCase();
  var at = have.indexOf(key);
  var y = window.scrollY;
  if (at < 0) have.push(key);
  else have.splice(at, 1);
  save();
  renderTabs();   // the week totals change
  renderList();
  window.scrollTo(0, y);
}

// The items on the list as it is shown now (all, this week, or the stock-up).
function shownItems() {
  return shopItems(week, stockFor(week) > -1 ? shopPart : "all");
}

// Updates the summary above the list: "$120.00 left", "3 of 25 ticked", the progress bar,
// and the "All done" message.
function updateSummary() {
  var count = 0, tickedCount = 0, homeCount = 0, left = 0, all = 0;
  shownItems().forEach(function (it) {
    if (isHome(it.name)) {
      homeCount++;
      return;
    }
    count++;
    all += it.price;
    if (isTicked(it)) tickedCount++;
    else left += it.price;
  });
  $("left").textContent = money(left) + " left";
  $("meta").textContent = tickedCount + " of " + count + " ticked" + (homeCount ? " · " + homeCount + " at home" : "") + " · total " + money(all);
  $("bar").style.width = (count ? tickedCount / count * 100 : 0) + "%";
  $("allDone").style.display = (count > 0 && tickedCount === count) ? "block" : "none";
}

// The items still to buy as plain text, grouped by aisle, for "Copy list".
function leftText() {
  var out = [(PLAN.weeks[week].name || "Week " + (week + 1)) + " shopping list"];
  grouped(shownItems()).forEach(function (group) {
    var lines = group[1].filter(function (it) { return !isHome(it.name) && !isTicked(it); })
      .map(function (it) { return "- " + it.name; });
    if (lines.length) {
      out.push("");
      out.push(group[0]);
      out = out.concat(lines);
    }
  });
  return out.join("\n");
}

// ---------- shop mode: one item at a time ----------

// While shop mode is open: {queue: [items in aisle order], at: position, skipped: {key: true}}.
var SHOP = null;
var wakeLock = null;

// A unique name for a shopping item, for remembering it in Shop mode.
function itemKey(it) { return it.src + "|" + it.id; }

// The items still to get, in aisle order (not ticked, not at home).
function shopQueue(only) {
  var out = [];
  grouped(shownItems()).forEach(function (g) {
    g[1].forEach(function (it) {
      it.aisle = g[0];
      if (!isHome(it.name) && !isTicked(it) && (!only || only[itemKey(it)])) out.push(it);
    });
  });
  return out;
}

// Opens Shop mode: one item at a time, in aisle order, with big buttons for in-store use.
function shopOpen() {
  SHOP = { queue: shopQueue(), at: 0, skipped: {} };
  $("shopMode").hidden = false;
  document.documentElement.classList.add("sm-open");
  try {
    if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { wakeLock = l; }).catch(function () {});
  } catch (e) {}
  shopDraw();
}

// Closes Shop mode and goes back to the list.
function shopClose() {
  SHOP = null;
  $("shopMode").hidden = true;
  document.documentElement.classList.remove("sm-open");
  try { if (wakeLock) wakeLock.release(); } catch (e) {}
  wakeLock = null;
  renderList();
  $("shopModeBtn").focus();
}

// Draws the item at SHOP.at, or the "finished" screen past the end.
function shopDraw() {
  if (!SHOP) return;
  var q = SHOP.queue;
  var it = q[SHOP.at];
  var done = q.filter(function (x) { return isTicked(x) || isHome(x.name); }).length;
  $("smBar").style.width = (q.length ? done / q.length * 100 : 0) + "%";
  $("smBack").disabled = SHOP.at === 0;
  var links = $("smLinks");
  links.textContent = "";
  if (!it) {
    var skipped = q.filter(function (x) { return SHOP.skipped[itemKey(x)] && !isTicked(x) && !isHome(x.name); });
    $("smCount").textContent = q.length ? done + " of " + q.length + " got" : "";
    $("smAisle").textContent = "";
    $("smName").textContent = !q.length ? "Nothing left to get" : skipped.length ? skipped.length + " skipped" : "All done";
    $("smPrice").textContent = skipped.length ? "Go back through the ones you skipped, or finish here." : "Everything on this list is ticked off or at home.";
    $("smState").textContent = "";
    $("smGot").textContent = skipped.length ? "Go through skipped" : "Finish";
    $("smGot").onclick = skipped.length ? function () {
      var only = {};
      skipped.forEach(function (x) { only[itemKey(x)] = true; });
      SHOP = { queue: shopQueue(only), at: 0, skipped: {} };
      shopDraw();
    } : shopClose;
    $("smSkip").hidden = $("smHome").hidden = true;
    $("smName").focus();
    return;
  }
  var ticked = isTicked(it);
  var home = isHome(it.name);
  $("smSkip").hidden = $("smHome").hidden = false;
  $("smCount").textContent = (SHOP.at + 1) + " of " + q.length;
  $("smAisle").textContent = it.aisle + (it.stock ? " · Stock-up" : "");
  $("smName").textContent = it.name;
  $("smPrice").textContent = money(it.price);
  $("smState").textContent = ticked ? "✓ Got it" : home ? "✓ At home" : "";
  storeLinks(it.name).forEach(function (a) { links.appendChild(a); });
  var pin = pinButton(it.name);
  if (pin) links.appendChild(pin);
  $("smGot").textContent = ticked ? "Untick" : "Got it";
  $("smGot").onclick = function () {
    toggle(it, !ticked, document.createElement("li"));
    if (ticked) shopDraw();
    else shopStep(1);
  };
  $("smHome").textContent = home ? "Not at home" : "At home";
  $("smHome").onclick = function () {
    toggleHome(it.name);
    if (home) shopDraw();
    else shopStep(1);
  };
  $("smSkip").onclick = function () {
    SHOP.skipped[itemKey(it)] = true;
    shopStep(1);
  };
  $("smName").focus();
}

// Moves Shop mode forward (by = 1) or back (by = -1) one item.
function shopStep(by) {
  if (!SHOP) return;
  SHOP.at = Math.max(0, Math.min(SHOP.queue.length, SHOP.at + by));
  shopDraw();
}

$("shopModeBtn").onclick = shopOpen;
$("smClose").onclick = shopClose;
$("smBack").onclick = function () { shopStep(-1); };
document.addEventListener("keydown", function (e) {
  if (!SHOP || $("pinDlg").open) return;
  if (e.key === "Escape") shopClose();
});

// Shows a message on a button for a moment, then puts its label back.
function flash(button, message, original) {
  button.textContent = message;
  setTimeout(function () { button.textContent = original; }, 1800);
}
