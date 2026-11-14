// The main app page, part 5 of 6: the Today tab, which shows today's meals, exercise and numbers
// from the phone on one screen. app-core.js lists all six parts.

// ---------- Today ----------

var phoneDay = null;      // the newest phone numbers {date, steps, active_energy, energy_in}, once loaded
var phoneFor = "";        // whose numbers phoneDay holds

// A card on Today: a heading (with a small note on the right), the body, and a link to the full view.
function todayCard(title, small, goLabel, onGo) {
  var card = el("section", "tcard");
  var h = el("h3", null, title);
  if (small) h.appendChild(el("small", null, small));
  card.appendChild(h);
  var body = el("div");
  card.appendChild(body);
  if (goLabel) {
    var go = el(typeof onGo === "string" ? "a" : "button", "tgo", goLabel + " ›");
    if (typeof onGo === "string") go.href = onGo;
    else {
      go.type = "button";
      go.onclick = onGo;
    }
    card.appendChild(go);
  }
  return { card: card, body: body, h: h };
}

// The Today meals card: today's rows for this person, with ticks, and the energy eaten so far.
// `info` is today's entry from mealDays; `person` is their block in the plan (or null) and `ppl`
// the plan's people.
function todayMealsCard(info, person, ppl) {
  var meals = todayCard("Today’s meals", "", "Meals and recipes", function () { dayName = TODAY; goTop(week, "meals"); });
  var energyLine = el("p", "note2");
  var ids = info.rows.map(function (row) { return info.d.day + "|" + row[0]; });
  // Updates the card after a tick: how many eaten and the energy so far.
  function update() {
    var list = eaten[week] || [];
    var done = 0, kjDone = 0;
    info.rows.forEach(function (row, i) {
      if (list.indexOf(ids[i]) < 0) return;
      done++;
      if (row[2] && !row.optional) kjDone += row[2].kj;
    });
    var old = meals.h.querySelector("small");
    if (old) meals.h.removeChild(old);
    meals.h.appendChild(el("small", null, done + " of " + ids.length + " eaten"));
    energyLine.textContent = info.known
      ? kjText(kjDone) + " eaten of " + kjText(info.tot.kj) + (info.miss ? "+" : "") + " planned today" + (person ? "" : " (one average serve)")
      : "";
  }
  info.rows.forEach(function (row, i) {
    meals.body.appendChild(eatenRow(row, ids[i], update));
  });
  if (info.fasting.length) meals.body.appendChild(el("p", "note2", fastingLine(info.fasting)));
  if (!person && ppl) meals.body.appendChild(el("p", "note2", "Pick a person in “Ticks for” to see their snacks and portion."));
  meals.body.appendChild(energyLine);
  if (info.d.note) meals.body.appendChild(el("p", "note2", info.d.note));
  update();
  return meals.card;
}

// One meal on Today with its "eaten" tick. `row` is [meal, dish, numbers], `id` is how the tick
// is saved ("Mon|Dinner"), and `afterTick` runs once a tick has been saved.
function eatenRow(row, id, afterTick) {
  var line = el("label", "sess");
  var box = el("input");
  box.type = "checkbox";
  box.checked = (eaten[week] || []).indexOf(id) > -1;
  box.setAttribute("aria-label", "Eaten: " + row[0]);
  box.onchange = function () {
    var list = eaten[week] || [];
    var at = list.indexOf(id);
    if (box.checked && at < 0) list.push(id);
    if (!box.checked && at > -1) list.splice(at, 1);
    eaten[week] = list;
    save();
    afterTick();
  };
  var text = el("span", "stxt");
  text.appendChild(el("span", "sk", row[0] + (row.optional ? " (if hungry)" : "")));
  text.appendChild(document.createTextNode(row[1]));
  line.appendChild(box);
  line.appendChild(el("span", "box"));
  line.appendChild(text);
  return line;
}

// The Today exercise card: today's sessions to tick, or "Rest day". `ex` is the week's exercise.
function todayExerciseCard(ex) {
  var exDay = (ex.days || []).filter(function (d) { return short(d.day) === TODAY; })[0] || {};
  var exCard = todayCard("Today’s exercise", "", "Exercise and workouts", function () { dayName = TODAY; goTop(week, "exercise"); });
  var any = false;
  EXSLOTS.forEach(function (slot) {
    if (exDay[slot[0]]) {
      exCard.body.appendChild(sessionRow(exDay, slot, exTicks[week] || []));
      any = true;
    }
  });
  if (!any) exCard.body.appendChild(el("p", "restday", "Rest day. Nothing planned today."));
  return exCard.card;
}

// The "From the phone" card on Today: the newest steps, active energy and food logged for
// `person4` (a person's key), from Health sync or an export. It asks the server for the numbers
// the first time and fills itself in when they arrive.
function todayPhoneCard(person4) {
  var phone = todayCard("From the phone", "", "Progress", "progress.html" + (person4 !== ME.person ? "?person=" + encodeURIComponent(person4) : ""));
  // Draws the card's body: the numbers, "Loading…", or how to set up Health sync.
  function drawPhone() {
    phone.body.textContent = "";
    var d = phoneFor === person4 ? phoneDay : null;
    if (!d) {
      phone.body.appendChild(el("p", "note2", phoneFor === person4
        ? "Nothing from the phone for today or yesterday yet. Health sync sends steps, active energy and food from an iPhone each day."
        : "Loading…"));
      if (phoneFor === person4) {
        var link = el("a", "tgo", "Set up Health sync ›");
        link.href = "health-sync.html";
        link.style.borderTop = "0";
        phone.body.appendChild(link);
      }
      return;
    }
    var old = phone.h.querySelector("small");
    if (old) phone.h.removeChild(old);
    phone.h.appendChild(el("small", null, d.date === localYmd(new Date()) ? "Today so far" : "Yesterday"));
    var stats = el("div", "tstats");
    [["steps", "steps", function (v) { return Math.round(v).toLocaleString(Appearance.locale()); }],
     ["active_energy", "active energy", kjText],
     ["energy_in", "food logged", kjText]].forEach(function (x) {
      if (d[x[0]] == null) return;
      var cell = el("div");
      cell.appendChild(el("b", null, x[2](d[x[0]])));
      cell.appendChild(el("span", null, x[1]));
      stats.appendChild(cell);
    });
    phone.body.appendChild(stats);
  }
  drawPhone();
  if (phoneFor !== person4) {
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    fetch("/api/progress?person=" + encodeURIComponent(person4) + "&weeks=4&tz=" + encodeURIComponent(tz), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        phoneFor = person4;
        phoneDay = d && d.latest ? d.latest : null;
        if (view === "today") drawPhone();
      })
      .catch(function () {});
  }
  return phone.card;
}

// The Today shopping card: what is left to buy this week. Null for a plan with no real list yet
// (only a $0 note).
function todayShoppingCard() {
  var count = 0, ticked = 0, left = 0, all = 0;
  shopItems(week, "all").forEach(function (it) {
    if (isHome(it.name)) return;
    count++;
    all += it.price;
    if (isTicked(it)) ticked++;
    else left += it.price;
  });
  if (!count || all <= 0) return null;
  var shop = todayCard("Shopping", ticked + " of " + count + " ticked", "Shopping list", function () { goTop(week, "shop"); });
  shop.body.appendChild(el("p", "tline", ticked === count ? "Everything is ticked off this week." : (count - ticked) + (count - ticked === 1 ? " item" : " items") + " left · about " + money(left)));
  var bar = el("div", "bar");
  var fill = el("i");
  fill.style.width = (ticked / count * 100) + "%";
  bar.appendChild(fill);
  shop.body.appendChild(bar);
  return shop.card;
}

// The Today view: today's meals and snacks to tick (with energy), today's exercise to tick,
// the newest numbers from the phone, and what is left to buy this week.
function renderToday() {
  var panel = $("todayView");
  panel.textContent = "";
  var w = PLAN.weeks[week];
  var ppl = PLAN.people || null;
  var key = pkOf(USER);
  var person = ppl && ppl[key] ? ppl[key] : null;
  var now = new Date();

  var top = el("div", "td-date");
  top.appendChild(el("h2", null, now.toLocaleDateString(Appearance.locale(), { weekday: "long", day: "numeric", month: "long" })));
  top.appendChild(el("span", null, (USER ? "For " + USER + " · " : "") + (w.name || "Week " + (week + 1))));
  panel.appendChild(top);

  // Meals: today's rows for this person.
  var dayIndex = -1;
  (w.meals || []).forEach(function (d, i) { if (short(d.day) === TODAY) dayIndex = i; });
  if (dayIndex > -1) {
    panel.appendChild(todayMealsCard(mealDays(w, person, person ? key : "", true)[dayIndex], person, ppl));
  } else if (w.meals && w.meals.length) {
    var none = todayCard("Today’s meals", "", "Meals and recipes", function () { goTop(week, "meals"); });
    none.body.appendChild(el("p", "note2", "This week has no meals listed for " + FULLDAY[TODAY] + "."));
    panel.appendChild(none.card);
  }

  var ex = exFor(week);
  if (ex) panel.appendChild(todayExerciseCard(ex));

  // From the phone: only for your own numbers, or an admin's pick.
  var person4 = ME && ME.person ? (isAdmin() ? ukey(USER) : ME.person) : "";
  if (person4) panel.appendChild(todayPhoneCard(person4));

  var shop = todayShoppingCard();
  if (shop) panel.appendChild(shop);

  var ask = el("a", "btn", "Ask AI about today");
  ask.href = "assistant.html";
  ask.style.cssText = "display:block;text-align:center;text-decoration:none;margin-top:.4rem";
  panel.appendChild(ask);
}
// The "Day plan | Macros" switch at the top of Meals and Macros.
function mealsToggle() {
  var seg = el("div", "mtoggle");
  [["meals", "Day plan"], ["macros", "Macros"]].forEach(function (option) {
    var b = el("button", "btn", option[1]);
    b.type = "button";
    b.setAttribute("aria-pressed", view === option[0]);
    b.onclick = function () { if (view !== option[0]) go(week, option[0]); };
    seg.appendChild(b);
  });
  return seg;
}
