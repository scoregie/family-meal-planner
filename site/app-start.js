// The main app page, part 6 of 6: showing a view, what the buttons do, and starting the page.
// It is loaded last because it runs straight away and uses the other five parts. app-core.js
// lists all six parts.

// ---------- showing a view ----------

// Reads the address (#week-2-meals) and draws that week and view. "#week-2" alone is Today.
function show() {
  var match = /^#week-(\d+)(-shop|-meals|-macros|-exercise|-ratings|-more)?$/.exec(location.hash);
  var n = match ? +match[1] : 1;
  week = (n >= 1 && n <= PLAN.weeks.length) ? n - 1 : 0;
  view = (match && match[2]) ? match[2].slice(1) : "today";
  // Ratings are for admins only. Stock-up weeks are shown as part of the week after them.
  if (view === "ratings" && !isAdmin()) view = "more";
  if (PLAN.weeks[week].kind === "stockup") week = planWeek(week);
  $("whoRow").hidden = !(isAdmin() && (view === "today" || view === "meals" || view === "exercise"));
  try { localStorage.setItem("coles-plan-place", location.hash); } catch (e) {}   // reopen this week next time

  renderTabs();
  $("tabs").hidden = view === "more";
  $("todayView").hidden = view !== "today";
  $("shopView").hidden = view !== "shop";
  $("meals").hidden = view !== "meals";
  $("macView").hidden = view !== "macros";
  $("exView").hidden = view !== "exercise";
  $("ratesView").hidden = view !== "ratings";
  $("moreView").hidden = view !== "more";
  document.querySelector("details.about").hidden = view !== "shop";   // "About this plan" explains the list
  $("vToday").setAttribute("aria-pressed", view === "today");
  $("vShop").setAttribute("aria-pressed", view === "shop");
  $("vMeals").setAttribute("aria-pressed", view === "meals" || view === "macros");
  $("vEx").setAttribute("aria-pressed", view === "exercise");
  $("vMore").setAttribute("aria-pressed", view === "more" || view === "ratings");

  if (view === "today") renderToday();
  else if (view === "shop") renderList();
  else if (view === "meals") renderMeals();
  else if (view === "macros") renderMacros();
  else if (view === "ratings") renderRatings();
  else if (view === "exercise") renderExercise();
  else if (view === "more") moreCalendar();
}

// Stock-up weeks have no meals or exercise, so those buttons jump to the next normal week
// (or the one before, if there is none after).
function planWeek(from) {
  for (var i = from; i < PLAN.weeks.length; i++) {
    if (PLAN.weeks[i].kind !== "stockup") return i;
  }
  for (i = from; i >= 0; i--) {
    if (PLAN.weeks[i].kind !== "stockup") return i;
  }
  return from;
}

// Goes to a view from the top of the page (and to today's card for Meals and Exercise).
function goTop(weekIndex, toView) {
  scrollToday = (toView === "meals" || toView === "exercise");
  window.scrollTo(0, 0);
  go(weekIndex, toView);
}

// The buttons along the bottom, and the avatar (top right), which opens More.
$("vToday").onclick = function () { goTop(planWeek(week), "today"); };
$("vShop").onclick = function () { goTop(week, "shop"); };
$("vMeals").onclick = function () { dayName = TODAY; goTop(planWeek(week), "meals"); };
$("vEx").onclick = function () { dayName = TODAY; goTop(planWeek(week), "exercise"); };
$("vMore").onclick = function () { goTop(week, "more"); };
$("acct").onclick = function (e) {
  e.preventDefault();
  goTop(week, "more");
};
$("ratesLink").onclick = function (e) {
  e.preventDefault();
  goTop(week, "ratings");
};

// "Hide ticked".
$("hide").onclick = function () {
  hideDone = !hideDone;
  this.setAttribute("aria-pressed", hideDone);
  $("lists").className = hideDone ? "hide-done" : "";
};

// "Copy list": copies what is left to buy. Older browsers use a hidden text box instead.
$("copy").onclick = function () {
  var button = this;
  var text = leftText();
  // For older browsers without the copy feature: copies through a hidden text box instead.
  function fallback() {
    var box = document.createElement("textarea");
    box.value = text;
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(box);
    flash(button, ok ? "Copied" : "Copy not available", "Copy list");
  }
  try {
    navigator.clipboard.writeText(text).then(function () { flash(button, "Copied", "Copy list"); }, fallback);
  } catch (e) {
    fallback();
  }
};

// A button that has to be tapped twice within 2.5 seconds, for things that can't be undone.
function twoTap(id, label, armedLabel, action) {
  var button = $(id);
  var armed = false;
  var timer;
  button.onclick = function () {
    if (!armed) {
      armed = true;
      button.textContent = armedLabel;
      timer = setTimeout(function () {
        armed = false;
        button.textContent = label;
      }, 2500);
      return;
    }
    clearTimeout(timer);
    armed = false;
    button.textContent = label;
    action();
  };
}

twoTap("clear", "Clear ticks", "Tap again to clear", function () {
  // Clears the ticks on the list as shown (this week, its stock-up, or both).
  shownItems().forEach(function (it) {
    ticks[it.src] = (ticks[it.src] || []).filter(function (id) { return id !== it.id; });
  });
  save();
  renderList();
});

// "Reset all" (admins): clears everyone's ticks, ratings and "At home" marks, here and on the server.
twoTap("resetall", "Reset all", "Tap again to reset everyone", function () {
  if (!(ME && ME.admin)) return;
  USERS.forEach(function (name) {
    try {
      localStorage.removeItem(TICKS_BASE + "-" + ukey(name));
      localStorage.removeItem(EX_BASE + "-" + ukey(name));
      localStorage.removeItem(EATEN_BASE + "-" + ukey(name));
    } catch (e) {}
  });
  try {
    localStorage.removeItem(TICKS_BASE);
    localStorage.removeItem(EX_BASE);
  } catch (e) {}
  ticks = {};
  exTicks = {};
  eaten = {};
  have = [];
  saveLocal();
  api("POST", "api/reset")
    .then(function () {
      setSync("Reset on server");
      pull();
    })
    .catch(function () { setSync("Offline: reset on this device only"); });
  show();
});

// "Ticks for" picker (admins): switch whose meal and exercise ticks are shown.
$("user").onchange = function () {
  try {
    localStorage.setItem("coles-plan-user", this.value);
    localStorage.setItem("coles-plan-person", PMAP[this.value]);
  } catch (e) {}
  if (PLAN) {
    loadUser();
    show();
    pull();
  }
};

window.addEventListener("hashchange", function () {
  if (PLAN) show();
});

// ---------- start ----------
(function start() {
  // With no #week-... in the address, go back to where this device was last time.
  if (!location.hash) {
    var place = lsGet("coles-plan-place");
    var placed = place && /^#week-(\d+)/.exec(place);
    if (placed) history.replaceState(null, "", "#week-" + placed[1]);   // that week, on Today
  }
  if (/-(meals|exercise)$/.test(location.hash)) scrollToday = true;
  try { have = JSON.parse(localStorage.getItem(HAVE_KEY)) || []; } catch (e) { have = []; }
  defaultPlan = JSON.parse($("plan-data").textContent);
  if (!PLAN_URL) {
    usePlan(defaultPlan);
    return;
  }

  // Fetches the plan. If the login has run out, Caddy redirects to the login page instead.
  function getPlan(url) {
    return fetch(url, { cache: "no-cache" }).then(function (response) {
      if (response.redirected && /\/login/.test(response.url)) {
        toLogin();
        throw {};
      }
      return response;
    });
  }

  // plan.json, or the example plan if there isn't one yet. If it is broken, show the built-in
  // plan with a red message saying what is wrong.
  getPlan(PLAN_URL)
    .then(function (response) { return response.status === 404 ? getPlan("plan.example.json") : response; })
    .then(function (response) {
      if (!response.ok) throw {};
      return response.text();
    })
    .then(function (text) {
      var p;
      try {
        p = JSON.parse(text);
      } catch (e) {
        throw { msg: "plan.json is not valid JSON (" + e.message + "). Showing the built-in plan." };
      }
      var problem = validate(p);
      if (problem) throw { msg: "plan.json problem: " + problem + " Showing the built-in plan." };
      usePlan(p);
    })
    .catch(function (e) {
      usePlan(defaultPlan);
      if (e && e.msg) showErr(e.msg);
    });
})();
