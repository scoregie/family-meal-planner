// The main app page, part 1 of 6: what every tab shares. Everything the page shows comes from
// plan.json (see docs/plan-format.md).
//
// How the page works, in short:
//   1. Load plan.json and draw the week tabs along the top.
//   2. The address after "#" says which week and view to show, for example #week-2-meals.
//      Changing it (by tapping a tab or a button along the bottom) redraws the page.
//   3. Ticks, ratings and "At home" marks are saved on this device straight away (localStorage),
//      then sent to the server (api/server.js) so every phone sees the same lists.
//   4. Every 30 seconds, and whenever the app is reopened, it fetches the latest from the server.
//
// The page's script is in six files, loaded by index.html in this order. They share their
// functions and values, so one file can call a function that lives in another:
//   app-core.js      (this file) what the page remembers, small helpers, people, saving and
//                    syncing, the week tabs, and showing one day at a time
//   app-shopping.js  the Shopping tab: the lists, ticks, "At home" and shop mode
//   app-meals.js     the Meals tab: meals, recipes, ratings, macros and small steps
//   app-exercise.js  the Exercise tab: the day's exercise, ticks and swapping an exercise
//   app-today.js     the Today tab
//   app-start.js     showing a view, the buttons, and starting the page (it runs last)

var PLAN_URL = "plan.json";

// ---------- what the page remembers ----------
var PLAN = null;          // the plan being shown
var defaultPlan = null;   // a tiny built-in plan, used if plan.json is missing or broken
var week = 0;             // which week is shown (0 is the first)
var view = "today";       // which view: "today", "shop", "meals", "macros", "exercise", "ratings" or "more"
var hideDone = false;     // "Hide ticked" on the shopping list

// What has been ticked. Each is saved on this device under its own key, and on the server.
var ticks = {};     // shopping ticks, shared by everyone: {week: ["0-1", "2-3"]}, where "0-1" = section 0, item 1
var exTicks = {};   // this person's exercise ticks: {week: ["Mon-cardio", ...]}
var eaten = {};     // this person's eaten meals: {week: ["Mon|Breakfast", ...]}
var rates = {};     // this person's meal ratings: {week: {"Mon|Dinner": {s: 7, n: "note", t: "dish"}}}
var have = [];      // items marked "At home" (their simplified names), shared by everyone
var openRate = "";  // which meal's rating box is open, as "week|Day|Meal"

// The localStorage key for each of those. They include the plan id, so a new plan starts clean.
var HAVE_KEY = "coles-plan-have-v1";
var TICKS_KEY = "", EX_KEY = "", EATEN_KEY = "", RATES_KEY = "";
var TICKS_BASE = "", EX_BASE = "", EATEN_BASE = "";   // the start of those keys, before the person's name

// Who is using the app.
var ME = null;        // the login: {user, person, admin}, from /auth/me (and remembered for offline use)
var USER = "";        // the name of the person whose ticks are shown, such as "Alex"
var USERS = [];       // everyone's names, in plan order
var PMAP = {};        // name -> person key: {"Alex": "adult1"}
var BY = {};          // who ticked each shopping item: {"week|item id": {who, at}}
var ALL_RATINGS = {}; // admins only: everyone's ratings, {person: {week: {...}}}
try { ME = JSON.parse(localStorage.getItem("coles-plan-me")); } catch (e) {}

// ---------- small helpers ----------

// Shortcut for document.getElementById.
function $(id) {
  return document.getElementById(id);
}

// Makes a new element, with an optional class name and text: el("p", "note", "Hello").
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// A price as "$12.50".
function money(n) {
  return Appearance.money(n, PLAN && PLAN.currency);
}

// Capital first letter: "alex" becomes "Alex".
function cap(s) {
  s = String(s || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Reads from localStorage, or null if it can't (for example in a private window).
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

// True if two values hold the same data.
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// True if the logged-in person is an admin.
function isAdmin() {
  return !!(ME && ME.admin);
}

// ---------- people ----------
// People come from the plan's "people" block (each entry with a "name").

// Turns a name into a simple key: "Alex" becomes "alex".
function ukey(name) {
  return Appearance.personKey(name);
}

// The display name for a key: "alex" gives "Alex".
function nameOf(key) {
  for (var i = 0; i < USERS.length; i++) {
    if (ukey(USERS[i]) === key) return USERS[i];
  }
  return cap(key);
}

// Reads the plan's people into USERS and PMAP, and fills the "Ticks for" picker.
function initPeople(p) {
  var all = (p && p.people) || {};
  USERS = [];
  PMAP = {};
  Object.keys(all).forEach(function (key) {
    var person = all[key];
    if (person && typeof person === "object" && person.name) {
      USERS.push(String(person.name));
      PMAP[person.name] = key;
    }
  });
  if (!USERS.length) USERS = ["Me"];
  var picker = $("user");
  if (picker) {
    picker.textContent = "";
    USERS.forEach(function (name) { picker.appendChild(el("option", null, name)); });
  }
  if (USERS.indexOf(USER) < 0) USER = USERS[0];
}

// The child's name (the person with school "weekday" lunches), for "Riley's version" in recipes.
function kidName() {
  var all = (PLAN && PLAN.people) || {};
  for (var key in all) {
    if (all[key] && all[key].weekday && all[key].name) return all[key].name;
  }
  return "Kids";
}

// Picks whose ticks to show, and loads them from this device. Non-admins always see their own.
function loadUser() {
  var remembered = lsGet("coles-plan-user");
  var picked = USERS.indexOf(remembered) > -1;
  if (picked) USER = remembered;
  // Start on your own name. An admin who has picked someone else on this device stays on them.
  if (ME && ME.person && (!ME.admin || !picked)) {
    var mine = nameOf(ME.person);
    if (USERS.indexOf(mine) > -1) USER = mine;
  }

  var key = ukey(USER);
  TICKS_KEY = TICKS_BASE;   // shopping ticks are shared, so no name on the end
  EX_KEY = EX_BASE + "-" + key;
  EATEN_KEY = EATEN_BASE + "-" + key;
  RATES_KEY = "coles-plan-rates-v1-" + (PLAN && PLAN.id || "default") + "-" + key;
  try { ticks = JSON.parse(lsGet(TICKS_KEY)) || {}; } catch (e) { ticks = {}; }
  try { exTicks = JSON.parse(lsGet(EX_KEY)) || {}; } catch (e) { exTicks = {}; }
  try { eaten = JSON.parse(lsGet(EATEN_KEY)) || {}; } catch (e) { eaten = {}; }
  try { rates = JSON.parse(lsGet(RATES_KEY)) || {}; } catch (e) { rates = {}; }
  openRate = "";

  // Admins get a picker; everyone else just sees their own name.
  var picker = $("user");
  var locked = !!(ME && !ME.admin);
  if (picker) {
    picker.value = USER;
    picker.hidden = locked;
  }
  var myName = $("meName");
  if (myName) {
    myName.textContent = USER;
    myName.hidden = !locked;
  }
  var label = document.querySelector('label[for="user"]');
  if (label) label.textContent = "Ticks for";
  var resetAll = $("resetall");
  if (resetAll) resetAll.hidden = !(ME && ME.admin);
}

// ---------- saving and syncing ----------

// Saves everything on this device.
function saveLocal() {
  try {
    localStorage.setItem(TICKS_KEY, JSON.stringify(ticks));
    localStorage.setItem(HAVE_KEY, JSON.stringify(have));
    localStorage.setItem(EX_KEY, JSON.stringify(exTicks));
    localStorage.setItem(EATEN_KEY, JSON.stringify(eaten));
    localStorage.setItem(RATES_KEY, JSON.stringify(rates));
  } catch (e) {}
}

var pushTimer = 0;   // waits a moment after a tick, so several quick ticks go to the server together
var dirty = false;   // true when there are changes the server hasn't got yet

// Updates the little "Synced" / "Offline" label. The full message shows when you hover over it.
function setSync(message) {
  var label = $("sync");
  if (!label) return;
  var offline = /^Offline/.test(message);
  label.textContent = offline ? "Offline" : (/Reset/.test(message) ? "Reset" : "Synced");
  label.title = message;
  label.className = "sync" + (offline ? " off" : "");
}

// Calls the server and returns its JSON answer. A 401 means the login has run out, so go to the login page.
function api(method, url, body) {
  var options = {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  };
  return fetch(url, options).then(function (response) {
    if (response.status === 401) toLogin();
    if (!response.ok) throw 0;
    return response.json();
  });
}

// Goes to the login page, coming back to this same place afterwards.
function toLogin() {
  location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
}

// Sends everything to the server: shopping ticks, this person's ticks and ratings, then "At home".
function pushNow() {
  var key = ukey(USER);
  api("PUT", "api/shared", { ticks: ticks })
    .then(function (answer) {
      // The server says who ticked each item. Update the "Ticked by" lines if that changed.
      if (answer && answer.by) {
        var changed = !same(answer.by, BY);
        BY = answer.by;
        if (changed && PLAN && view === "shop") refreshBylines();
      }
    })
    .then(function () { return api("PUT", "api/user/" + key, { ex: exTicks, eaten: eaten, ratings: rates }); })
    .then(function () { return api("PUT", "api/have", { have: have }); })
    .then(function () {
      dirty = false;
      setSync("Saved to server");
    })
    .catch(function () {
      setSync("Offline: saved on this device only");
    });
}

// Saves on this device now, and on the server in 0.4 seconds (unless something else changes first).
function save() {
  saveLocal();
  dirty = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 400);
}

// Gets the latest from the server and redraws if anything changed. If this device has changes
// the server hasn't got (for example after being offline), it sends those instead.
function pull() {
  if (dirty) {
    pushNow();
    return;
  }
  api("GET", "api/state").then(function (s) {
    var key = ukey(USER);
    var needPush = false;   // this device has something the server doesn't
    var changed = false;    // the server had something new, so redraw

    // An admin pressed "Reset all" since this device last synced: clear everything here too.
    var localEpoch = lsGet("coles-plan-epoch");
    if (localEpoch !== null && localEpoch !== String(s.epoch || 0)) {
      ticks = {};
      exTicks = {};
      eaten = {};
      rates = {};
      have = [];
      changed = true;
    }
    try { localStorage.setItem("coles-plan-epoch", String(s.epoch || 0)); } catch (e) {}

    // Shopping ticks and who ticked them.
    if (s.shared && !same(s.shared.by || {}, BY)) {
      BY = s.shared.by || {};
      changed = true;
    }
    if (s.shared && s.shared.ticks) {
      if (!same(s.shared.ticks, ticks)) {
        ticks = s.shared.ticks;
        changed = true;
      }
    } else if (Object.keys(ticks).length) {
      needPush = true;
    }

    // This person's meal and exercise ticks and ratings.
    if (s.users && s.users[key]) {
      var serverEx = s.users[key].ex || {};
      var serverEaten = s.users[key].eaten || {};
      var serverRates = s.users[key].ratings;
      if (!same(serverEx, exTicks) || !same(serverEaten, eaten)) {
        exTicks = serverEx;
        eaten = serverEaten;
        changed = true;
      }
      if (serverRates === undefined) {
        if (Object.keys(rates).length) needPush = true;
      } else if (!same(serverRates, rates)) {
        rates = serverRates;
        changed = true;
      }
    } else if (Object.keys(exTicks).length || Object.keys(eaten).length || Object.keys(rates).length) {
      needPush = true;
    }

    // Admins: everyone's ratings, for the Ratings view.
    if (ME && ME.admin) {
      var everyone = {};
      Object.keys(s.users || {}).forEach(function (person) {
        everyone[person] = (s.users[person] && s.users[person].ratings) || {};
      });
      if (!same(everyone, ALL_RATINGS)) {
        ALL_RATINGS = everyone;
        if (view === "ratings") changed = true;
      }
    }

    // "At home" marks.
    if (Array.isArray(s.have)) {
      if (!same(s.have, have)) {
        have = s.have;
        changed = true;
      }
    } else if (have.length) {
      needPush = true;
    }

    if (changed) {
      saveLocal();
      // Don't redraw while someone is typing a rating note, or they would lose their place.
      var focused = document.activeElement;
      if (PLAN && !(focused && focused.tagName === "TEXTAREA")) show();
    }
    if (needPush) pushNow();
    setSync("Synced");
  }).catch(function () {
    setSync("Offline: saved on this device only");
  });
}

// Check the server every 30 seconds while the app is open, and as soon as it is reopened.
setInterval(function () {
  if (!document.hidden && PLAN) pull();
}, 30000);
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && PLAN) pull();
});

// Shows a red message at the top of the page.
function showErr(message) {
  var box = $("err");
  box.textContent = message;
  box.hidden = false;
}

// Starts using a plan: reads its people, works out the storage keys, and draws the page.
function usePlan(p) {
  PLAN = p;
  initPeople(p);
  var id = p.id || "default";
  TICKS_BASE = "coles-plan-ticks-v2-" + id;
  EX_BASE = "coles-plan-ex-v1-" + id;
  EATEN_BASE = "coles-plan-eaten-v1-" + id;
  loadUser();
  // The app's name stays at the top; the plan's own title shows in the browser tab after it.
  $("sub").textContent = p.subtitle || "";
  document.title = p.title ? p.title + " · Family Health Planner" : "Family Health Planner";
  show();
  pull();
  if (ME && ME.user && typeof setMe === "function") setMe(ME);   // the Plan setup banner depends on the plan
}

// ---------- week tabs ----------

// Goes to a week and view by changing the address (#week-2-meals). The "hashchange" listener redraws.
function go(weekIndex, toView) {
  location.hash = "week-" + (weekIndex + 1) + (toView === "today" ? "" : "-" + toView);
}

// Draws the row of week tabs (stock-up weeks are folded into the week after them), each with
// its rough cost including any stock-up, and scrolls the chosen one into view.
function renderTabs() {
  var row = $("tabs");
  row.textContent = "";
  PLAN.weeks.forEach(function (wk, i) {
    if (wk.kind === "stockup") return;   // shopped with the week after it
    var tab = el("button", "tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", i === week);
    tab.appendChild(el("b", null, wk.name || ("Week " + (i + 1))));
    tab.appendChild(el("span", null, "~" + Appearance.money(total(i), PLAN && PLAN.currency, true)));
    tab.onclick = function () { go(i, view); };
    row.appendChild(tab);
  });

  // If the chosen tab is off screen (on a phone), scroll the row so it sits in the middle.
  var chosen = row.querySelector('[aria-selected="true"]');
  if (chosen) {
    var left = chosen.offsetLeft - row.offsetLeft;
    var right = left + chosen.offsetWidth;
    var offScreen = left < row.scrollLeft + 16 || right > row.scrollLeft + row.clientWidth - 16;
    if (offScreen) row.scrollLeft = left - (row.clientWidth - chosen.offsetWidth) / 2;
  }
}

// ---------- today ----------

var TODAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()];
var scrollToday = false;   // scroll to today's card once, after opening Meals or Exercise

// Highlights today's day card with a "Today" tag (and scrolls to it if asked).
function markToday(card, heading, day) {
  if (String(day || "").slice(0, 3) !== TODAY) return;
  card.classList.add("today");
  heading.appendChild(el("span", "today-tag", "Today"));
  if (scrollToday) {
    scrollToday = false;
    setTimeout(function () {
      var y = card.getBoundingClientRect().top + window.scrollY - 12;
      window.scrollTo(0, Math.max(0, y));
    }, 0);
  }
}

// ---------- calendar ----------

// A date as YYYY-MM-DD in the phone's own time zone.
function localYmd(d) {
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}

// "Add to calendar" for a person's suggested eating times: an Apple Calendar file (which also
// works in Outlook), and a list of Google Calendar links that loads when opened.
function calBlock(personKey) {
  var start = localYmd(new Date(Date.now() + 864e5));   // tomorrow
  var startQuery = "?start=" + start;
  var wrap = el("div", "cal");
  wrap.appendChild(el("h4", null, "Add these times to your calendar"));

  var row = el("div", "cal-btns");
  var apple = el("a", "btn", "Apple Calendar");
  apple.href = "/api/calendar/" + personKey + ".ics" + startQuery;
  apple.setAttribute("aria-label", "Add all suggested times to Apple Calendar or Outlook");
  row.appendChild(apple);

  var google = el("details", "cal-g");
  google.appendChild(el("summary", "btn", "Google Calendar"));
  var links = el("ul", "cal-list");
  google.appendChild(links);
  row.appendChild(google);
  wrap.appendChild(row);
  wrap.appendChild(el("p", "note2", "Starts tomorrow, repeats for 4 weeks, with a reminder 10 minutes before. “Mon to Fri” times skip weekends. Apple Calendar adds them all at once. For Google, add each time below, or download the Apple file and import it at calendar.google.com (Settings, Import)."));

  // The Google links are only fetched the first time the list is opened.
  google.addEventListener("toggle", function () {
    if (!google.open || links.childNodes.length) return;
    links.appendChild(el("li", null, "Loading…"));
    var timeZone = "";
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    api("GET", "/api/calendar/" + personKey + ".json" + startQuery).then(function (cal) {
      links.textContent = "";
      cal.events.forEach(function (e) {
        var url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
          + "&text=" + encodeURIComponent(e.title)
          + "&dates=" + e.date + "T" + e.start + "/" + e.date + "T" + e.end
          + "&details=" + encodeURIComponent(e.details)
          + "&recur=" + encodeURIComponent("RRULE:" + e.rrule)
          + (timeZone ? "&ctz=" + encodeURIComponent(timeZone) : "");
        var item = el("li");
        var link = el("a", null, "Add “" + e.title + "”");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.appendChild(link);
        item.appendChild(el("span", "mk2", " · " + e.when));
        links.appendChild(item);
      });
    }).catch(function () {
      links.textContent = "";
      links.appendChild(el("li", null, "Could not load the times. Check your connection."));
    });
  });
  return wrap;
}

// ---------- one day at a time (Meals and Exercise) ----------

var FULLDAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
var dayName = TODAY;   // the day shown in Meals and Exercise ("Mon"); starts on today

// A day's short name: "Monday" gives "Mon".
function short(day) {
  return String(day || "").slice(0, 3);
}

// The meal weeks (not stock-ups), in order.
function mealWeeks() {
  var out = [];
  PLAN.weeks.forEach(function (w, i) { if (w.kind !== "stockup") out.push(i); });
  return out;
}

// The day header: ‹ arrow, the day's name, › arrow, then a row of day buttons. Going past the
// last day moves to the next week (and back from the first day to the week before), wrapping
// around the plan. `days` is the week's list of {day: "Mon", ...}.
function dayNav(days, rerender) {
  var names = days.map(function (d) { return short(d.day); });
  var at = Math.max(0, names.indexOf(dayName));
  var weeks = mealWeeks();
  var wAt = weeks.indexOf(week);

  // Moves to the day before (dir -1) or after (dir 1), if there is one.
  function step(dir) {
    var next = at + dir;
    if (next >= 0 && next < names.length) {
      dayName = names[next];
      rerender();
      return;
    }
    var nw = weeks[(wAt + dir + weeks.length) % weeks.length];
    var other = (PLAN.weeks[nw][view === "exercise" ? "exercise" : "meals"] && nw !== week) ? nw : week;
    var otherDays = view === "exercise" ? ((exFor(other) || {}).days || days) : (PLAN.weeks[other].meals || days);
    dayName = short((dir > 0 ? otherDays[0] : otherDays[otherDays.length - 1]).day);
    if (other === week) rerender();
    else go(other, view);
  }

  var wrap = el("div", "daynav");
  var top = el("div", "daynav-top");
  var prev = el("button", "btn arrow", "‹");
  prev.type = "button";
  prev.setAttribute("aria-label", "Previous day");
  prev.onclick = function () { step(-1); };
  var title = el("div", "daynav-title");
  var h = el("h2", null, FULLDAY[names[at]] || names[at] || "");
  if (names[at] === TODAY) h.appendChild(el("span", "today-tag", "Today"));
  title.appendChild(h);
  title.appendChild(el("span", null, PLAN.weeks[week].name || "Week " + (week + 1)));
  var next = el("button", "btn arrow", "›");
  next.type = "button";
  next.setAttribute("aria-label", "Next day");
  next.onclick = function () { step(1); };
  top.appendChild(prev);
  top.appendChild(title);
  top.appendChild(next);
  wrap.appendChild(top);

  var chips = el("div", "daychips");
  names.forEach(function (n, i) {
    var b = el("button", null, n.slice(0, 2));
    b.type = "button";
    b.setAttribute("aria-label", FULLDAY[n] || n);
    b.setAttribute("aria-pressed", i === at);
    if (n === TODAY) b.className = "is-today";
    b.onclick = function () { dayName = n; rerender(); };
    chips.appendChild(b);
  });
  wrap.appendChild(chips);
  return { el: wrap, index: at, step: step };
}

// Lets a swipe left or right on `target` move to the next or previous day.
function swipeDays(target, step) {
  var x0 = null, y0 = null;
  target.addEventListener("touchstart", function (e) {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  target.addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    var dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
}

// A titled box of lines (strings), or null if there are none.
function adviceBox(title, lines, cls) {
  lines = lines.filter(Boolean);
  if (!lines.length) return null;
  var box = el("section", "advice" + (cls ? " " + cls : ""));
  box.appendChild(el("h3", null, title));
  var list = el("ul", "bul");
  lines.forEach(function (t) { list.appendChild(el("li", null, t)); });
  box.appendChild(list);
  return box;
}

// The same as a box that opens and closes (closed to start), or null if there are no lines.
function noteFold(title, lines, cls) {
  lines = lines.filter(Boolean);
  if (!lines.length) return null;
  var fold = el("details", "exfold" + (cls ? " " + cls : ""));
  fold.appendChild(el("summary", null, title));
  var inner = el("div");
  var list = el("ul", "bul");
  lines.forEach(function (t) { list.appendChild(el("li", null, t)); });
  inner.appendChild(list);
  fold.appendChild(inner);
  return fold;
}
