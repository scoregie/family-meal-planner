// The main app page, part 4 of 6: the Exercise tab. Each person's exercise for a day, their ticks,
// and swapping an exercise for another from the library. app-core.js lists all six parts.

// ---------- exercise for a person and day ----------

// A person's exercise plan for a week (by plan key), or null. One plan for everyone
// ({"days": [...]}) or one per person ({"<person key>": {"days": [...]}}).
function exPlanFor(weekIndex, personKey) {
  var e = PLAN.weeks[weekIndex] && PLAN.weeks[weekIndex].exercise;
  if (!e) return null;
  if (Array.isArray(e.days)) return e;
  return e[personKey] && Array.isArray(e[personKey].days) ? e[personKey] : null;
}

// The day's sessions from a person's exercise plan: {day, cardio, strength, ...}, {} for a day
// with nothing on, or null when they have no exercise plan that week.
function exDayOf(weekIndex, personKey, day) {
  var plan = exPlanFor(weekIndex, personKey);
  if (!plan) return null;
  return plan.days.filter(function (d) { return short(d.day) === short(day); })[0] || {};
}

// True if a day has a strength (weights) session.
function isWeightsDay(exDay) {
  if (!exDay) return false;
  if (exDay.strength) return true;
  return EXSLOTS.some(function (slot) {
    return exDay[slot[0]] && /strength|weights|resistance/i.test(exDay[slot[0]]) && !/^optional/i.test(exDay[slot[0]]);
  });
}

// True if any session is planned on a day.
function isActiveDay(exDay) {
  return !!exDay && EXSLOTS.some(function (slot) { return exDay[slot[0]] && !/^optional|^rest/i.test(exDay[slot[0]]); });
}

// Which meal week (1 to 4) the week at `weekIndex` is, not counting the stock-up weeks before it.
function mealWeekNumber(weekIndex) {
  var n = 0;
  for (var i = 0; i <= weekIndex && i < PLAN.weeks.length; i++) if (Array.isArray(PLAN.weeks[i].meals)) n++;
  return n;
}

// True if a snack is eaten on `day`: its "days" list includes the day (or it has no list), and
// its "exercise" fits that day's exercise: "strength" (weights days only), "rest" (days without
// weights), "active" (days with any session) or "inactive". Without an exercise plan for the
// person, the exercise rule is ignored. A snack with a "weeks" list (like [3, 4]) is only eaten
// in those meal weeks: used when someone builds up to more vegetables and fruit over the plan.
function snackOn(snack, day, personKey, weekIndex) {
  day = short(day);
  if (Array.isArray(snack.days) && snack.days.indexOf(day) < 0) return false;
  if (Array.isArray(snack.weeks) && weekIndex != null && weekIndex >= 0 && snack.weeks.indexOf(mealWeekNumber(weekIndex)) < 0) return false;
  if (!snack.exercise || !personKey || weekIndex == null) return true;
  var exDay = exDayOf(weekIndex, personKey, day);
  if (!exDay) return true;
  if (snack.exercise === "strength") return isWeightsDay(exDay);
  if (snack.exercise === "rest") return !isWeightsDay(exDay);
  if (snack.exercise === "active") return isActiveDay(exDay);
  if (snack.exercise === "inactive") return !isActiveDay(exDay);
  return true;
}

// The sessions on a day as text: "Strength: Strength A …".
function sessionLines(exDay) {
  var out = [];
  EXSLOTS.forEach(function (slot) {
    if (exDay && exDay[slot[0]]) out.push(slot[1] + ": " + exDay[slot[0]]);
  });
  return out;
}

// ---------- exercise ----------

// Session slots a day can have, in display order: [key in plan.json, label]. "cardio", "strength"
// and "mobility" suit plans that don't fix a time of day; "morning", "afternoon" and "session" are the original ones.
var EXSLOTS = [
  ["morning", "Morning"],
  ["afternoon", "Afternoon"],
  ["cardio", "Easy cardio"],
  ["strength", "Strength"],
  ["mobility", "Mobility"],
  ["session", "Session"],
];

// How many sessions a week's exercise plan has.
function exCount(ex) {
  var n = 0;
  (ex.days || []).forEach(function (day) {
    EXSLOTS.forEach(function (slot) {
      if (day[slot[0]]) n++;
    });
  });
  return n;
}

// The person key for a name: "Alex" gives "adult1".
function pkOf(name) {
  return PMAP[name] || ukey(name);
}

// This person's exercise plan for a week, or null.
function exFor(weekIndex) {
  return exPlanFor(weekIndex, pkOf(USER));
}

// The plan-wide exercise details (workouts, notes, medical considerations, videos), shared or for this person.
function exExtras() {
  var e = PLAN.exercise || {};
  if (e.workouts || e.notes || e.medical || e.videos) return e;
  return e[pkOf(USER)] || {};
}

// Updates "3 of 11 sessions done this week".
function updateExCount() {
  var count = $("exCount");
  var ex = exFor(week);
  if (!count || !ex) return;
  count.textContent = "";
  count.appendChild(el("b", null, (exTicks[week] || []).length + " of " + exCount(ex) + " sessions done"));
  count.appendChild(el("span", null, "This week"));
}

// The short name a workout goes by in the day plan: "Strength A" from "Strength A: Squat, press…".
function workoutKey(workout) {
  return String(workout.name || "").split(":")[0].trim().toLowerCase();
}

// The workouts a day's sessions mention, in the order they are mentioned.
function workoutsFor(exDay, workouts) {
  var text = sessionLines(exDay).join(" ").toLowerCase();
  return workouts.filter(function (wk) {
    var key = workoutKey(wk);
    return key && new RegExp("\\b" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text);
  });
}

// The Exercise view: one day's sessions to tick, the workouts for that day (open, to follow
// mid-workout), the week's focus, all the workouts, general notes, and a separate box of
// medical considerations, each in a box that opens.
function renderExercise() {
  var panel = $("exView");
  panel.textContent = "";
  var w = PLAN.weeks[week];
  var ex = exFor(week);
  var extras = exExtras();
  if (!ex) {
    panel.appendChild(el("p", "emptyline", w.exercise ? "No exercise plan for " + USER + " this week yet." : "No exercise plan is listed for this week."));
    return;
  }
  var count = el("p", "count");
  count.id = "exCount";
  panel.appendChild(count);

  var days = ex.days || [];
  var nav = dayNav(days, renderExercise);
  panel.appendChild(nav.el);
  var day = days[nav.index] || {};
  var done = exTicks[week] || [];

  var card = el("section", "day daycard");
  var any = false;
  EXSLOTS.forEach(function (slot) {
    if (day[slot[0]]) {
      card.appendChild(sessionRow(day, slot, done));
      any = true;
    }
  });
  if (!any) card.appendChild(el("p", "restday", "Rest day. Nothing planned today."));
  panel.appendChild(card);
  swipeDays(card, nav.step);

  var workouts = extras.workouts || [];
  var todays = workoutsFor(day, workouts);
  loadExlib();
  if (todays.length) {
    panel.appendChild(el("h2", "rh", "Today’s workouts"));
    todays.forEach(function (workout) {
      var fold = workoutFold(workout, extras.videos || {}, todayLines(workout, day));
      fold.open = true;
      panel.appendChild(fold);
    });
  }

  // The week's focus, which opens to show its targets.
  if (ex.focus || (ex.targets && ex.targets.length)) {
    var fold = el("details", "exfold");
    var inner = el("div");
    var focus = el("div", "exfocus");
    if (ex.targets && ex.targets.length) {
      var targets = el("ul", "bul");
      ex.targets.forEach(function (t) { targets.appendChild(el("li", null, t)); });
      focus.appendChild(targets);
    }
    fold.appendChild(el("summary", null, ex.focus || "This week's plan"));
    inner.appendChild(focus);
    fold.appendChild(inner);
    panel.appendChild(fold);
  }

  var others = workouts.filter(function (wk) { return todays.indexOf(wk) < 0; });
  if (others.length) {
    var all = el("details", "exfold");
    all.appendChild(el("summary", null, todays.length ? "Other workouts" : "Workouts"));
    var allInner = el("div");
    others.forEach(function (workout) { allInner.appendChild(workoutFold(workout, extras.videos || {})); });
    all.appendChild(allInner);
    panel.appendChild(all);
  }

  var notes = noteFold("Good to know", extras.notes || []);
  if (notes) panel.appendChild(notes);

  var medical = noteFold("Medical considerations", extras.medical || [], "medical");
  if (medical) {
    medical.lastChild.appendChild(el("p", "note2", "This is general information, not medical advice. What your doctor, physio or other health professional tells you comes first. If anything here doesn’t match what they said, follow them."));
    panel.appendChild(medical);
  }
  panel.appendChild(el("p", "note2", CHECK_WITH_GP));
  updateExCount();
}

// One exercise session to tick, such as "Easy cardio: 20 minute walk". Saved as "Mon-cardio".
function sessionRow(day, slot, done) {
  var id = day.day + "-" + slot[0];
  var label = el("label", "sess");
  var box = el("input");
  box.type = "checkbox";
  box.checked = done.indexOf(id) > -1;
  box.onchange = function () {
    var list = exTicks[week] || [];
    var at = list.indexOf(id);
    if (box.checked && at < 0) list.push(id);
    if (!box.checked && at > -1) list.splice(at, 1);
    exTicks[week] = list;
    save();
    updateExCount();
  };
  var text = el("span", "stxt");
  text.appendChild(el("span", "sk", slot[1]));
  text.appendChild(document.createTextNode(day[slot[0]]));
  label.appendChild(box);
  label.appendChild(el("span", "box"));
  label.appendChild(text);
  return label;
}

// One workout as a fold-out list of exercises. An exercise written as "Goblet squat (3 × 10): ..."
// whose name is in `videos` gets a Demo link and a YouTube search link.
// What today's sessions say about a workout, without its name: "Easy walk, 25 minutes." from
// "Workout F: Easy walk, 25 minutes.". The day's amount wins over the workout's general one.
function todayLines(workout, exDay) {
  var key = workoutKey(workout);
  var esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var has = new RegExp("\\b" + esc + "\\b", "i");
  var lead = new RegExp("^\\s*(optional:\\s*)?" + esc + "\\s*[:,-]?\\s*", "i");
  var name = String(workout.name || "").toLowerCase();
  var out = [];
  EXSLOTS.forEach(function (slot) {
    var text = exDay && exDay[slot[0]];
    if (!text || !has.test(text)) return;
    var optional = /^\s*optional:/i.test(text);
    var rest = String(text).replace(lead, "").trim();
    if (!rest || name.indexOf(rest.toLowerCase()) >= 0) return;
    out.push((optional ? "Optional: " : "") + rest.charAt(0).toUpperCase() + rest.slice(1));
  });
  return out;
}

// A folding section for one workout: its name, then each exercise with how to do it and a video link.
function workoutFold(workout, videos, today) {
  var fold = el("details");
  var summary = el("summary", null, workout.name || "Workout");
  if (workout.time && !(today && today.length)) summary.appendChild(el("span", null, workout.time));
  fold.appendChild(summary);
  (today || []).forEach(function (line) {
    var p = el("p", "today");
    p.appendChild(el("b", null, "Today: "));
    p.appendChild(document.createTextNode(line));
    fold.appendChild(p);
  });
  var list = el("ol", "bul steps");
  (workout.items || []).forEach(function (text, index) {
    var item = el("li", null, text);
    var swap = swapButton(workout, index, text);
    if (swap) item.appendChild(swap);
    var colon = text.indexOf(": ");
    if (colon > 0) {
      var name = text.slice(0, colon).replace(/\s*\(.*?\)/g, "").trim();
      if (Object.prototype.hasOwnProperty.call(videos, name)) {
        item.appendChild(document.createTextNode(" "));
        if (/^https?:\/\//.test(videos[name])) {
          var demo = el("a", "vlink", "Demo");
          demo.href = videos[name];
          demo.target = "_blank";
          demo.rel = "noopener noreferrer";
          item.appendChild(demo);
          item.appendChild(document.createTextNode(" · "));
        }
        var youtube = el("a", "vlink", "YouTube");
        youtube.href = "https://www.youtube.com/results?search_query=" + encodeURIComponent(name + " exercise form");
        youtube.target = "_blank";
        youtube.rel = "noopener noreferrer";
        item.appendChild(youtube);
      }
    }
    list.appendChild(item);
  });
  fold.appendChild(list);
  return fold;
}

// ---------- swapping an exercise ----------

var EXLIB = null;        // the exercise library for this person: {exercises, fits, avoid, person}
var exlibLoading = false;

// Loads the library once (for the person whose plan is shown), then redraws the Exercise view
// so the Swap buttons appear.
function loadExlib() {
  var person = ukey(USER);
  if (exlibLoading || (EXLIB && EXLIB.person === person)) return;
  exlibLoading = true;
  fetch("/api/exercises?person=" + encodeURIComponent(person), { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      exlibLoading = false;
      if (!d) return;
      d.person = person;
      EXLIB = d;
      if (view === "exercise") {
        var y = window.scrollY;
        renderExercise();
        window.scrollTo(0, y);
      }
    })
    .catch(function () { exlibLoading = false; });
}

// The library exercise a workout line is about, or null (the same matching as the server's).
function exMatch(text) {
  if (!EXLIB) return null;
  var name = String(text).replace(/^(warm-up|cool-down)\s*:\s*/i, "").split(/\s*[(:]/)[0].trim().toLowerCase();
  if (!name) return null;
  var all = EXLIB.exercises;
  for (var i = 0; i < all.length; i++) if (all[i].name.toLowerCase() === name) return all[i];
  for (i = 0; i < all.length; i++) {
    var n = all[i].name.toLowerCase();
    if (name.indexOf(n) === 0 || n.indexOf(name) === 0) return all[i];
  }
  return null;
}

// Exercises that could replace `ex`: the same kind (squats and lunges count as one), that suit the
// person and aren't left out, easiest first.
function exAlternatives(ex) {
  var legs = { squat: 1, lunge: 1 };
  return EXLIB.exercises.filter(function (e) {
    return e.id !== ex.id && (e.type === ex.type || (legs[e.type] && legs[ex.type]))
      && EXLIB.fits.indexOf(e.id) > -1 && EXLIB.avoid.indexOf(e.id) < 0;
  }).sort(function (a, b) { return a.level - b.level || (a.name < b.name ? -1 : 1); });
}

// A small "Swap" button for a workout line that matches the library, or null. Shared workouts
// (one set for everyone) can only be changed by admins.
function swapButton(workout, index, text) {
  var shared = PLAN.exercise && Array.isArray(PLAN.exercise.workouts);
  if (shared && !isAdmin()) return null;
  var ex = exMatch(text);
  if (!ex || !exAlternatives(ex).length) return null;
  var b = el("button", "swapbtn", "Swap");
  b.type = "button";
  b.setAttribute("aria-label", "Swap " + ex.name + " for another exercise");
  b.onclick = function () { openSwap(workout, index, ex); };
  return b;
}

var LEVELS = ["", "Easier", "Medium", "Harder"];
var EQUIPS = { none: "No equipment", bands: "Bands", dumbbells: "Dumbbells", gym: "Gym" };

// The swap box: the other exercises to choose from, and whether to leave this one out of future plans.
function openSwap(workout, index, ex) {
  var dlg = $("swapDlg");
  $("swapName").textContent = ex.name;
  $("swapAvoidName").textContent = ex.name;
  $("swapAvoid").checked = true;
  $("swapMsg").textContent = "";
  var list = $("swapList");
  list.textContent = "";
  exAlternatives(ex).forEach(function (e) {
    var b = el("button", "swapopt");
    b.type = "button";
    b.appendChild(el("b", null, e.name));
    b.appendChild(el("span", null, e.dose + " · " + EQUIPS[e.equipment] + " · " + LEVELS[e.level]));
    b.appendChild(el("small", null, e.how));
    b.onclick = function () {
      list.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      $("swapMsg").textContent = "Saving…";
      fetch("/api/exercises/swap?person=" + encodeURIComponent(ukey(USER)), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "app" },
        body: JSON.stringify({ workout: workout.name, item: index, to: e.id, avoid: $("swapAvoid").checked }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || "Couldn’t swap it. Try again.");
        });
      }).then(function () {
        $("swapMsg").textContent = "Swapped. Reloading…";
        location.reload();
      }).catch(function (err) {
        list.querySelectorAll("button").forEach(function (x) { x.disabled = false; });
        $("swapMsg").textContent = (err && err.message) || "Couldn’t swap it. Try again.";
      });
    };
    list.appendChild(b);
  });
  if (dlg.showModal) dlg.showModal();
  else dlg.setAttribute("open", "");
}
