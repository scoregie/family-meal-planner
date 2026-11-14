// The main app page, part 3 of 6: the Meals tab. Each day's meals and recipes, meal ratings, the
// macros card and small steps (a new food to try each week). app-core.js lists all six parts.

// ---------- meal ratings ----------

// This person's rating for a meal this week: {s: score, n: note}, or {} if none.
function getRate(id) {
  return (rates[week] || {})[id] || {};
}

// Changes a rating. `patch` is the part that changed, like {s: 7} or {n: "too salty"}.
// A rating with no score and no note is removed. `dish` is saved too, for the Ratings view.
function setRate(id, patch, dish) {
  var weekRates = rates[week] || {};
  var rating = Object.assign({}, weekRates[id] || {}, patch);
  if (!rating.s) delete rating.s;
  if (!rating.n || !rating.n.trim()) delete rating.n;
  if (rating.s || rating.n) {
    if (dish) rating.t = dish;
    weekRates[id] = rating;
  } else {
    delete weekRates[id];
  }
  if (Object.keys(weekRates).length) rates[week] = weekRates;
  else delete rates[week];
  save();
}

// Makes a meal's Rate button work. `button` opens `box`, which has scores 1 to 10, a note and
// Clear/Done buttons. `summary` shows the note when the box is closed. Only one box is open at a time.
function rateUI(id, what, button, summary, box, dish) {
  var key = week + "|" + id;
  var boxId = "rate-" + key.replace(/[^a-z0-9]/gi, "-");
  box.id = boxId;
  button.setAttribute("aria-controls", boxId);

  // Updates the button, the summary and whether the box is showing.
  function paint() {
    var rating = getRate(id);
    var open = openRate === key;
    button.textContent = rating.s ? rating.s + "/10" : (rating.n ? "Note" : "Rate");
    button.className = "rate-btn" + (rating.s || rating.n ? " has" : "");
    button.setAttribute("aria-expanded", open);
    button.setAttribute("aria-label", (rating.s ? "Rated " + rating.s + " out of 10. " : "") + "Rate " + what);
    summary.hidden = open || !rating.n;
    summary.textContent = rating.n ? "“" + rating.n.trim() + "”" : "";
    box.hidden = !open;
  }

  // Fills the box with the score buttons, the note and the Clear/Done buttons.
  function build() {
    box.textContent = "";
    var rating = getRate(id);
    box.appendChild(el("p", null, "How was it? 1 = did not like it, 10 = loved it."));

    var scores = el("div", "scores");
    scores.setAttribute("role", "group");
    scores.setAttribute("aria-label", "Score out of 10");
    for (var n = 1; n <= 10; n++) {
      scores.appendChild(scoreButton(n, rating, scores));
    }
    box.appendChild(scores);

    addNote(rating);
    addFoot();
  }

  // Adds the note box ("What didn't you like?") to the rating box. It saves as you type.
  function addNote(rating) {
    var noteId = boxId + "-note";
    var label = el("label", null, "What didn't you like? (optional)");
    label.htmlFor = noteId;
    box.appendChild(label);
    var note = el("textarea");
    note.id = noteId;
    note.maxLength = 1000;
    note.rows = 2;
    note.placeholder = "e.g. too spicy, sauce was bland, not enough veg";
    note.value = rating.n || "";
    note.oninput = function () {
      setRate(id, { n: note.value }, dish);
      paint();
      summary.hidden = true;
    };
    box.appendChild(note);
  }

  // Adds the "Clear rating" and "Done" buttons to the bottom of the rating box.
  function addFoot() {
    var foot = el("div", "rate-foot");
    var clear = el("button", "btn", "Clear rating");
    var done = el("button", "btn", "Done");
    clear.type = done.type = "button";
    clear.onclick = function () {
      setRate(id, { s: 0, n: "" });
      build();
      paint();
    };
    done.onclick = function () {
      openRate = "";
      paint();
      button.focus();
    };
    foot.appendChild(clear);
    foot.appendChild(done);
    box.appendChild(foot);
  }

  // One score button. Pressing the current score again clears it.
  function scoreButton(n, rating, scores) {
    var b = el("button", null, String(n));
    b.type = "button";
    b.setAttribute("aria-pressed", rating.s === n);
    b.setAttribute("aria-label", n + " out of 10");
    b.onclick = function () {
      var current = getRate(id).s;
      setRate(id, { s: current === n ? 0 : n }, dish);
      scores.querySelectorAll("button").forEach(function (other, i) {
        other.setAttribute("aria-pressed", getRate(id).s === i + 1);
      });
      paint();
    };
    return b;
  }

  // Opening this box closes any other open one.
  button.onclick = function () {
    if (openRate === key) {
      openRate = "";
      paint();
      return;
    }
    var previous = openRate && document.getElementById("rate-" + openRate.replace(/[^a-z0-9]/gi, "-"));
    openRate = key;
    build();
    paint();
    if (previous) {
      previous.hidden = true;
      var previousButton = document.querySelector('[aria-controls="' + previous.id + '"]');
      if (previousButton) previousButton.setAttribute("aria-expanded", "false");
      var previousSummary = previous.previousSibling;
      if (previousSummary && previousSummary.className === "rate-sum" && previousSummary.textContent) previousSummary.hidden = false;
    }
  };

  if (openRate === key) build();
  paint();
}

// The Ratings view (admins only): every rated dish with everyone's scores and notes,
// lowest average first, so the meals worth changing are at the top.
function renderRatings() {
  var box = $("ratesView");
  box.textContent = "";
  if (!isAdmin()) {
    box.appendChild(el("p", "emptyline", "Only an admin can see everyone's ratings."));
    return;
  }

  // "All weeks" or "This week".
  var scope = "all";
  try { scope = localStorage.getItem("coles-plan-rscope") || "all"; } catch (e) {}
  var head = el("div", "rs-head");
  head.appendChild(el("h2", null, "Meal ratings"));
  var choice = el("div", "seg");
  [["all", "All weeks"], ["week", "This week"]].forEach(function (option) {
    var b = el("button", "btn", option[1]);
    b.type = "button";
    b.setAttribute("aria-pressed", scope === option[0]);
    b.onclick = function () {
      try { localStorage.setItem("coles-plan-rscope", option[0]); } catch (e) {}
      renderRatings();
    };
    choice.appendChild(b);
  });
  head.appendChild(choice);
  box.appendChild(head);

  var collected = collectRatings(scope);
  var dishes = collected.dishes;
  var order = collected.order;
  if (!order.length) {
    var none = scope === "week"
      ? "Nobody has rated a meal this week yet."
      : "Nobody has rated a meal yet. Ratings show up here once people use the Rate button on the Meals tab.";
    box.appendChild(el("p", "emptyline", none));
    return;
  }

  // Average score for each dish (dishes with only notes have no average).
  order.forEach(function (key) {
    var dish = dishes[key];
    var scored = dish.rows.filter(function (r) { return r.s; });
    dish.avg = scored.length ? scored.reduce(function (sum, r) { return sum + r.s; }, 0) / scored.length : null;
    dish.n = scored.length;
  });
  // Lowest average first, then the most ratings. Dishes with no score go last.
  order.sort(function (a, b) {
    var A = dishes[a], B = dishes[b];
    if (A.avg === null) return B.avg === null ? 0 : 1;
    if (B.avg === null) return -1;
    return A.avg - B.avg || B.n - A.n;
  });

  var peopleCount = collected.peopleCount;
  box.appendChild(el("p", "rs-note", order.length + (order.length === 1 ? " dish" : " dishes") + " rated by " + peopleCount + (peopleCount === 1 ? " person" : " people") + ". Lowest average score first, so meals worth changing are at the top."));
  var list = el("ul", "rs-list");
  order.forEach(function (key) {
    list.appendChild(ratingCard(dishes[key]));
  });
  box.appendChild(list);
}

// Gathers everyone's ratings by dish. Returns {dishes: {key: {name, rows, where}}, order, peopleCount}.
function collectRatings(scope) {
  // The person being edited on this device uses the freshest local copy.
  var all = Object.assign({}, ALL_RATINGS);
  all[ukey(USER)] = rates;
  var dishes = {}, order = [], people = {};

  Object.keys(all).forEach(function (personKey) {
    var personRates = all[personKey] || {};
    Object.keys(personRates).forEach(function (w) {
      var weekIndex = +w;
      if (!PLAN.weeks[weekIndex] || (scope === "week" && weekIndex !== week)) return;
      Object.keys(personRates[w]).forEach(function (id) {
        var rating = personRates[w][id];
        var parts = id.split("|");   // "Mon|Dinner"
        var day = parts[0];
        var meal = parts[1] || "";
        var dayMeals = (PLAN.weeks[weekIndex].meals || []).filter(function (x) { return x.day === day; })[0];
        // The dish name saved with the rating, or the one in the plan, or just "Mon Dinner".
        var dish = rating.t || (dayMeals && dayMeals[meal.toLowerCase()]) || (day + " " + meal);
        var key = dish.trim().toLowerCase();
        if (!dishes[key]) {
          dishes[key] = { name: dish.trim(), rows: [], where: {} };
          order.push(key);
        }
        var weekName = PLAN.weeks[weekIndex].name || ("Week " + (weekIndex + 1));
        var where = weekName + ", " + day + " " + meal.toLowerCase();
        dishes[key].where[where] = 1;
        dishes[key].rows.push({ who: nameOf(personKey), s: rating.s, n: rating.n, where: where });
        people[personKey] = 1;
      });
    });
  });
  return { dishes: dishes, order: order, peopleCount: Object.keys(people).length };
}

// One dish in the Ratings view: its name, where it was eaten, the average, and each person's score and note.
function ratingCard(dish) {
  var card = el("li", "rs-card");
  var top = el("div", "rs-top");
  var name = el("div", "rs-dish", dish.name);
  // If the dish was eaten on more than one day, say which day each rating is for.
  var severalPlaces = dish.rows.some(function (r, i) {
    return dish.rows.some(function (other, j) { return j !== i && other.where !== r.where; });
  });
  name.appendChild(el("span", "rs-where", Object.keys(dish.where).join(" · ")));
  top.appendChild(name);

  var colour = dish.avg === null ? "" : dish.avg < 5 ? " low" : dish.avg < 7 ? " mid" : " high";
  var average = el("div", "rs-avg" + colour);
  var rounded = Math.round(dish.avg * 10) / 10;
  if (dish.avg === null) {
    average.appendChild(el("b", null, "–"));
    average.appendChild(el("small", null, "no score"));
  } else {
    average.appendChild(el("b", null, rounded + ""));
    average.appendChild(el("small", null, dish.n > 1 ? "avg of " + dish.n : "out of 10"));
  }
  average.setAttribute("aria-label", dish.avg === null ? "No score yet" : "Average " + rounded + " out of 10 from " + dish.n + (dish.n === 1 ? " rating" : " ratings"));
  top.appendChild(average);
  card.appendChild(top);

  // Each person, lowest score first (notes without a score last).
  var list = el("ul", "rs-people");
  dish.rows.sort(function (a, b) { return (a.s || 11) - (b.s || 11); }).forEach(function (r) {
    var row = el("li");
    row.appendChild(el("span", "rs-who", r.who));
    row.appendChild(el("span", "rs-sc", r.s ? r.s + "/10" : "–"));
    var text = el("span", "rs-txt", r.n ? "“" + r.n.trim() + "”" : (r.s ? "No note" : ""));
    if (severalPlaces) {
      text.appendChild(document.createTextNode(r.n || r.s ? " " : ""));
      text.appendChild(el("i", null, "(" + r.where + ")"));
    }
    row.appendChild(text);
    list.appendChild(row);
  });
  card.appendChild(list);
  return card;
}

// ---------- meals ----------

// The meals one person eats on a day, as [label, dish] pairs: the shared meal, then their own
// breakfast or packed school lunch, then anything an admin set just for them (day.people[key]).
// `person` is the person's plan entry (or null for everyone) and `personKey` their key.
function mealRows(day, person, personKey) {
  var rows = [["Breakfast", day.breakfast], ["Lunch", day.lunch], ["Dinner", day.dinner]];
  var extra = [];
  if (person && person.weekday && person.weekday[day.day]) {
    var school = person.weekday[day.day];
    // "School provides lunch" is not packed.
    if (school.lunch) rows[1] = ["Lunch", school.lunch + (school.lunch.indexOf("School") === 0 ? "" : " (packed)")];
    if (school.snack) extra.push(["School snack", school.snack]);
  }
  if (person && person.breakfast) rows[0] = ["Breakfast", person.breakfast];
  var own = personKey && day.people && day.people[personKey];
  if (own) {
    rows.forEach(function (row) {
      var dish = own[row[0].toLowerCase()];
      if (dish) row[1] = dish;
    });
  }
  // Leave out empty meals.
  return rows.concat(extra).filter(function (row) { return row[1]; });
}

// True if a meal slot says the person goes without that meal on a fast day.
function isFasting(dish) {
  return String(dish || "").trim().toLowerCase() === "fasting";
}

// "Fast day: no breakfast or lunch." for the meals someone goes without, or "" if there are none.
function fastingLine(meals) {
  if (!meals || !meals.length) return "";
  var last = meals[meals.length - 1];
  return "Fast day: no " + (meals.length > 1 ? meals.slice(0, -1).join(", ") + " or " + last : last) + ".";
}

// ---------- macros ----------
// Macros come from the plan's "macros" block: {"Dish name": {"p": protein g, "c": carbs g, "f": fat g}}
// for one average serve. A person's numbers are scaled by their portion.

// How a dish name is matched to its macros: lower case, ignoring a trailing "(packed)".
function macroKey(s) {
  return String(s || "").replace(/\s*\(packed\)\s*$/i, "").trim().toLowerCase();
}

// The macros for a dish as {p, c, f, kj}, or null if there are none.
function macrosOf(dish) {
  var macros = PLAN.macros || {};
  // Build a lookup by macroKey the first time (PLAN._mk), so later lookups are quick.
  if (!PLAN._mk) {
    PLAN._mk = {};
    Object.keys(macros).forEach(function (name) {
      PLAN._mk[macroKey(name)] = macros[name];
    });
  }
  var v = PLAN._mk[macroKey(dish)];
  if (!v || typeof v !== "object") return null;
  var p = +v.p || 0, c = +v.c || 0, f = +v.f || 0;
  if (!p && !c && !f && !v.kj && !v.kcal) return null;
  // Energy in kJ from the factors on Australian food labels (FSANZ): 17 kJ/g protein and carbs, 37 kJ/g fat.
  var kj = +v.kj || (+v.kcal ? v.kcal * 4.184 : 17 * p + 17 * c + 37 * f);
  return { p: p, c: c, f: f, kj: kj };
}

// The food groups in one average serve of a dish, from the plan's "groups" block (made by
// tools/estimate_groups.py), or null. Used by the healthy-eating guidelines card (guidelines.js).
function groupsOf(dish) {
  var groups = PLAN.groups || {};
  if (!PLAN._gk) {
    PLAN._gk = {};
    Object.keys(groups).forEach(function (name) {
      PLAN._gk[macroKey(name)] = groups[name];
    });
  }
  var g = PLAN._gk[macroKey(dish)];
  return g && typeof g === "object" ? g : null;
}

// Multiplies macros by a number (such as a portion of 1.2).
function scaleM(m, factor) {
  return { p: m.p * factor, c: m.c * factor, f: m.f * factor, kj: m.kj * factor };
}

// Adds macros `m` onto the running total `t`.
function addM(t, m) {
  t.p += m.p;
  t.c += m.c;
  t.f += m.f;
  t.kj += m.kj;
}

// "1,234 kJ".
function kjText(n) {
  if (window.Appearance) return Appearance.energyText(n);   // kJ or kcal, from Settings
  return Math.round(n).toLocaleString(Appearance.locale()) + " kJ";
}

// "1,234 kJ · P 20 g · C 40 g · F 10 g".
function macroLine(m) {
  return kjText(m.kj) + " · P " + Math.round(m.p) + " g · C " + Math.round(m.c) + " g · F " + Math.round(m.f) + " g";
}

var macroMode = "";   // the macros card: "today" or "avg" (daily average); "" means pick for me

// The three macros: [name, letter, kJ per gram, colour].
var MACROS = [
  ["Protein", "p", 17, "var(--m-p)"],
  ["Carbs", "c", 17, "var(--m-c)"],
  ["Fat", "f", 37, "var(--m-f)"],
];

// kJ from protein, carbs and fat only (used for the percentages, so they add up to 100).
function macroEnergy(m) {
  return MACROS.reduce(function (sum, x) { return sum + m[x[1]] * x[2]; }, 0);
}

// A thin bar split into protein, carbs and fat by their share of the energy (kJ).
// With `legend` (the list under the main card), hovering or focusing a block highlights its
// row. Without one (the per-day bars) the text line under the bar has the numbers, so the bar
// is just decoration and is hidden from screen readers.
function macroBar(m, legend) {
  var sum = macroEnergy(m);
  var bar = el("div", "mac-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", "Energy by macro: " + MACROS.map(function (x) {
    return x[0] + " " + (sum ? Math.round(m[x[1]] * x[2] / sum * 100) : 0) + "%";
  }).join(", "));

  MACROS.forEach(function (x, i) {
    var energy = m[x[1]] * x[2];
    if (!sum || !energy) return;
    var block = el("span");
    var text = x[0] + ": " + Math.round(m[x[1]]) + " g, " + Math.round(energy / sum * 100) + "% of energy";
    block.style.flexGrow = energy;   // each block's width is its share of the energy
    block.style.flexBasis = "0";
    block.style.setProperty("--c", x[3]);
    block.title = text;
    block.tabIndex = 0;
    block.setAttribute("aria-label", text);

    var legendRow = legend ? legend.children[i] : null;
    if (!legendRow) {
      block.removeAttribute("tabindex");
      block.removeAttribute("aria-label");
      bar.removeAttribute("role");
      bar.setAttribute("aria-hidden", "true");
      bar.appendChild(block);
      return;
    }
    block.onmouseenter = block.onfocus = function () { legendRow.classList.add("hi"); };
    block.onmouseleave = block.onblur = function () { legendRow.classList.remove("hi"); };
    bar.appendChild(block);
  });
  return bar;
}

// The big card at the top of the Macros view: today's (or the daily average) kJ, the bar, and
// grams and percentages for each macro. Returns null when there is nothing to show.
function macroCard(days, person) {
  var withData = days.filter(function (x) { return x.known; });
  var missing = days.reduce(function (sum, x) { return sum + x.miss; }, 0);
  var box = el("section", "mac");
  var head = el("div", "mac-head");
  var heading = el("h3");
  head.appendChild(heading);
  box.appendChild(head);

  if (!withData.length) {
    heading.textContent = "Macros";
    box.appendChild(el("p", "mac-note", "No macros are set for this week's meals yet." + (isAdmin() ? " Add them on the Edit plan page (More)." : "")));
    return isAdmin() ? box : null;
  }

  // "Today" or "Daily average". Today is only offered when today is in this week.
  var today = withData.filter(function (x) { return String(x.d.day || "").slice(0, 3) === TODAY; })[0];
  var mode = macroMode || (today ? "today" : "avg");
  if (mode === "today" && !today) mode = "avg";
  if (today) head.appendChild(macroModeChoice(mode));

  var m = { p: 0, c: 0, f: 0, kj: 0 };
  var source = mode === "today" ? [today] : withData;
  source.forEach(function (x) { addM(m, x.tot); });
  if (mode !== "today") m = scaleM(m, 1 / withData.length);
  heading.textContent = (mode === "today" ? "Today’s macros" : "Daily macros (average)") + (person ? " · " + person.name : "");

  var energy = macroEnergy(m);
  var kjLine = el("p", "mac-kj");
  var unit = window.Appearance ? Appearance.energyUnit() : "kJ";
  kjLine.appendChild(el("b", null, Math.round(window.Appearance ? Appearance.energyValue(m.kj) : m.kj).toLocaleString(Appearance.locale())));
  kjLine.appendChild(el("span", null, unit));
  box.appendChild(kjLine);

  var legend = macroLegend(m, energy);
  box.appendChild(macroBar(m, legend));
  box.appendChild(legend);

  var note = person
    ? "Scaled to " + person.name + "’s portion (" + person.portion + "×). "
    : "For one average serve. Pick a person above to see their portion. ";
  note += "The bar and percentages show the share of energy from each. ";
  note += person
    ? "Includes " + person.name + "’s snacks, apart from any marked “if hungry”."
    : "Snacks are different for each person, so pick a person to include them.";
  if (mode !== "today" && withData.length < days.length) note += " Averaged over " + withData.length + " of " + days.length + " days.";
  if (missing) note += " " + missing + (missing === 1 ? " meal has" : " meals have") + " no macros yet, so the totals are low.";
  box.appendChild(el("p", "mac-note", note));
  return box;
}

// The "Today | Daily average" switch on the macros card. `mode` is the one showing now.
function macroModeChoice(mode) {
  var choice = el("div", "seg");
  [["today", "Today"], ["avg", "Daily average"]].forEach(function (option) {
    var b = el("button", "btn", option[1]);
    b.type = "button";
    b.setAttribute("aria-pressed", mode === option[0]);
    b.onclick = function () {
      macroMode = option[0];
      var y = window.scrollY;
      renderMacros();
      window.scrollTo(0, y);
    };
    choice.appendChild(b);
  });
  return choice;
}

// The list under the macros bar: each macro's colour, grams, and share of the energy (`energy` is the total).
function macroLegend(m, energy) {
  var legend = el("ul", "mac-leg");
  MACROS.forEach(function (x) {
    var item = el("li");
    var swatch = el("span", "mac-sw");
    swatch.style.background = x[3];
    item.appendChild(swatch);
    var text = el("span");
    text.appendChild(document.createTextNode(x[0] + " "));
    text.appendChild(el("b", null, Math.round(m[x[1]]) + " g"));
    item.appendChild(text);
    item.appendChild(el("small", null, (energy ? Math.round(m[x[1]] * x[2] / energy * 100) : 0) + "%"));
    legend.appendChild(item);
  });
  return legend;
}

// Which person is picked on the Meals and Macros views ("all" for everyone), remembered on this device.
function pickWho(ppl) {
  var who = "all";
  try { who = localStorage.getItem("coles-plan-person") || "all"; } catch (e) {}
  return (!ppl || (who !== "all" && !ppl[who])) ? "all" : who;
}

// The "Everyone / Alex / Sam / Riley" buttons. `rerender` redraws the view after a pick.
function personSeg(ppl, who, rerender) {
  var seg = el("div", "seg pseg");
  var options = [["all", "Everyone"]].concat(
    Object.keys(ppl)
      .filter(function (key) { return ppl[key] && ppl[key].name; })
      .map(function (key) { return [key, ppl[key].name]; })
  );
  options.forEach(function (option) {
    var b = el("button", "btn", option[1]);
    b.type = "button";
    b.setAttribute("aria-pressed", who === option[0]);
    b.onclick = function () {
      try { localStorage.setItem("coles-plan-person", option[0]); } catch (e) {}
      rerender();
    };
    seg.appendChild(b);
  });
  return seg;
}


// Each day's meals for one person (or everyone), with macros scaled to their portion.
// With `withSnacks`, the person's snacks are added too. Snacks marked "optional" (like
// "if hungry") are shown last but not added to the totals.
// Returns a list of {d: the day, rows: [[label, dish, macros]], tot: macro totals, known, miss}.
function mealDays(w, person, who, withSnacks) {
  var portion = person && +person.portion > 0 ? +person.portion : 1;
  return w.meals.map(function (day) {
    var rows = mealRows(day, person, person ? who : "");
    // Meals this person goes without on a fast day ("Fasting" in the plan) aren't meals to tick,
    // rate or count: they are listed on their own line.
    var fasting = person ? rows.filter(function (row) { return isFasting(row[1]); }).map(function (row) { return row[0].toLowerCase(); }) : [];
    if (person) rows = rows.filter(function (row) { return !isFasting(row[1]); });
    var tot = { p: 0, c: 0, f: 0, kj: 0 };
    var known = 0;    // meals with macros
    var miss = 0;     // meals without
    var optional = [];

    rows.forEach(function (row) {
      var m = macrosOf(row[1]);
      row.push(m ? scaleM(m, portion) : null);
      if (m) {
        known++;
        addM(tot, row[2]);
      } else {
        miss++;
      }
    });

    if (withSnacks && person && Array.isArray(person.snacks)) {
      person.snacks.forEach(function (snack) {
        if (!snack || !snack.what || !snackOn(snack, day.day, who, PLAN.weeks.indexOf(w))) return;
        // Snack amounts are already written for this person, so they are not scaled.
        var row = ["Snack" + (snack.when ? " · " + snack.when : ""), snack.what, macrosOf(snack.what)];
        row.snack = true;   // already sized for this person, so not scaled by their portion
        if (snack.optional) {
          row.optional = true;
          optional.push(row);
          return;
        }
        rows.push(row);
        if (row[2]) {
          known++;
          addM(tot, row[2]);
        } else {
          miss++;
        }
      });
    }
    return { d: day, rows: rows.concat(optional), tot: tot, known: known, miss: miss, fasting: fasting };
  });
}

// The Macros view: the person picker, the macros card, then each day with its kJ, a bar and every meal.
function renderMacros() {
  var panel = $("macView");
  panel.textContent = "";
  panel.appendChild(mealsToggle());
  var w = PLAN.weeks[week];
  var ppl = PLAN.people || null;
  if (!w.meals || !w.meals.length) {
    panel.appendChild(el("p", "emptyline", "No meals are listed for this week."));
    return;
  }
  var who = pickWho(ppl);
  if (ppl) {
    panel.appendChild(personSeg(ppl, who, function () {
      var y = window.scrollY;
      renderMacros();
      window.scrollTo(0, y);
    }));
  }
  var person = who !== "all" && ppl ? ppl[who] : null;
  var days = mealDays(w, person, who, true);
  var card = macroCard(days, person);
  if (card) panel.appendChild(card);
  // How the week compares with healthy-eating guidelines (for one person, since they depend on age and sex).
  if (person && window.Guidelines) {
    panel.appendChild(Guidelines.card({
      days: days,
      person: person,
      who: who,
      portion: +person.portion > 0 ? +person.portion : 1,
      groupsOf: groupsOf,
      profileKey: ukey(person.name),
      isAdmin: isAdmin(),
    }));
  } else if (ppl && window.Guidelines) {
    panel.appendChild(el("p", "mac-note", "Pick a person to compare their week with healthy-eating guidelines."));
  }
  if (!days.some(function (x) { return x.known; })) return;

  panel.appendChild(macroDaysHeading());
  var list = el("ul", "days");
  days.forEach(function (dayInfo) { list.appendChild(macroDay(dayInfo)); });
  panel.appendChild(list);
}

// The "Each day" heading on Macros, with a key to the bar's colours.
function macroDaysHeading() {
  var head = el("div", "mac-h");
  head.appendChild(el("h2", null, "Each day"));
  var key = el("div", "mac-key");
  key.setAttribute("aria-hidden", "true");
  MACROS.forEach(function (x) {
    var item = el("span");
    var swatch = el("span", "mac-sw");
    swatch.style.background = x[3];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(x[0]));
    key.appendChild(item);
  });
  head.appendChild(key);
  return head;
}

// One day on Macros: its energy, a bar, the protein, carbs and fat, then every meal with its numbers.
function macroDay(dayInfo) {
  var day = dayInfo.d;
  var card = el("li", "day");
  var heading = el("h3", null, day.day || "");
  card.appendChild(heading);
  markToday(card, heading, day.day);
  if (dayInfo.known) {
    // "+" means some meals have no macros, so the real total is higher.
    heading.appendChild(el("span", "dk", kjText(dayInfo.tot.kj) + (dayInfo.miss ? "+" : "")));
    card.appendChild(macroBar(dayInfo.tot, null));
    var t = dayInfo.tot;
    card.appendChild(el("p", "mac-day", "P " + Math.round(t.p) + " g · C " + Math.round(t.c) + " g · F " + Math.round(t.f) + " g" + (dayInfo.miss ? " · " + dayInfo.miss + " without macros" : "")));
  }
  dayInfo.rows.forEach(function (row) {
    var line = el("p", "mrow");
    line.appendChild(el("span", "mk", row[0]));
    line.appendChild(el("span", "mv", row[1]));
    line.appendChild(row[2] ? el("span", "mm", macroLine(row[2])) : el("span", "mm none", "No macros yet"));
    if (row.optional) {
      line.className = "mrow opt";
      line.appendChild(el("span", "mm none", "If hungry, so not in the totals"));
    }
    card.appendChild(line);
  });
  return card;
}

// Shown under each person's meal guide and exercise plan.
var CHECK_WITH_GP = "Please check this meal and exercise plan with your GP, dietitian or physio before you start, especially if you take medicines, are pregnant or have a health condition. It’s general information, not medical advice.";

// The box at the top of the Meals view for one person: portion, guide, suggested eating times
// (with "Add to calendar"), tips and snacks.
function personGuide(person, personKey) {
  var box = el("div", "exfocus");
  box.appendChild(el("h3", null, person.name + " (portion " + person.portion + "× average)"));
  if (person.guide) box.appendChild(el("p", null, person.guide));

  // A line with a label on the left and text on the right.
  function line(label, text) {
    var p = el("p", "meal");
    p.appendChild(el("span", "mk", label));
    p.appendChild(el("span", "mv", text));
    return p;
  }

  if (person.times && person.times.length) {
    box.appendChild(el("h4", null, "Suggested eating times"));
    person.times.forEach(function (t) { box.appendChild(line(t.when, t.what)); });
    if (person.timesNote) box.appendChild(el("p", "note2", person.timesNote));
    box.appendChild(calBlock(personKey));
  }
  if (person.tips && person.tips.length) {
    box.appendChild(el("h4", null, "Tips and things to check"));
    var tips = el("ul", "bul");
    person.tips.forEach(function (tip) { tips.appendChild(el("li", null, tip)); });
    box.appendChild(tips);
  }
  if (person.snacks && person.snacks.length) box.appendChild(el("h4", null, "Snacks"));
  (person.snacks || []).forEach(function (snack) { box.appendChild(line(snack.when, snack.what)); });
  var steps = smallStepsBlock(person);
  if (steps) box.appendChild(steps);
  box.appendChild(el("p", "note2", CHECK_WITH_GP));
  return box;
}

// ---------- small steps (a new food to try each week) ----------

var stepsTried = {};   // person's login key -> {food: "tried" | "liked" | "not yet"}, once loaded

// "Small steps" for one person: this week's new food to try (a short step on from a food they
// already like), with buttons to say how it went. The answer is saved on the server, and the next
// plan carries on from there. Returns null if their plan has no steps.
function smallStepsBlock(person) {
  if (!Array.isArray(person.steps) || !person.steps.length) return null;
  var number = mealWeekNumber(week);
  var step = person.steps.filter(function (s) { return s.week === number; })[0] || person.steps[0];
  var key = ukey(person.name);
  var wrap = el("div");
  wrap.appendChild(el("h4", null, "Small steps: this week’s new food"));
  var p = el("p", "meal");
  p.appendChild(el("span", "mk", "Try"));
  p.appendChild(el("span", "mv", step.food));
  wrap.appendChild(p);
  if (step.how) wrap.appendChild(el("p", "note2", step.how + (step.from ? " (A step on from " + step.from + ".)" : "")));
  wrap.appendChild(el("p", "note2", "A taste is enough, with no need to finish it. It often takes many tries before a new food is liked."));
  var row = el("div", "row");
  var said = el("p", "note2");

  // Shows which answer is chosen (if any).
  function show() {
    var result = (stepsTried[key] || {})[step.food] || "";
    Array.prototype.forEach.call(row.children, function (b) { b.setAttribute("aria-pressed", b.value === result); });
    said.textContent = result === "liked" ? "Saved. The next plan will use it in meals." : result ? "Saved. It will be offered again." : "";
  }
  [["tried", "Tried it"], ["liked", "Liked it"], ["not yet", "Not this time"]].forEach(function (option) {
    var b = el("button", "btn", option[1]);
    b.type = "button";
    b.value = option[0];
    b.onclick = function () {
      // Tapping the chosen answer again clears it.
      var now = (stepsTried[key] || {})[step.food] === option[0] ? "" : option[0];
      fetch("/api/steps?person=" + encodeURIComponent(key), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Requested-With": "app" },
        body: JSON.stringify({ food: step.food, result: now }),
      }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (d) { stepsTried[key] = d.tried; show(); })
        .catch(function () { said.textContent = "That didn’t save. Only they or an admin can tick this."; });
    };
    row.appendChild(b);
  });
  wrap.appendChild(row);
  wrap.appendChild(said);
  if (stepsTried[key]) show();
  else {
    fetch("/api/steps?person=" + encodeURIComponent(key), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : { tried: {} }; })
      .then(function (d) { stepsTried[key] = d.tried || {}; show(); })
      .catch(function () {});
  }
  return wrap;
}

// One meal in a day card: an "eaten" tick box, the label and dish, anyone with a different meal
// (in the Everyone view), and a Rate button with its rating box.
function mealRow(card, day, row, person, ppl, updateEaten) {
  var line = el("p", "meal");
  var id = (day.day || "") + "|" + row[0];   // like "Mon|Dinner"
  var eatenThisWeek = eaten[week] || [];

  var box = el("input", "eat");
  box.type = "checkbox";
  box.checked = eatenThisWeek.indexOf(id) > -1;
  box.setAttribute("aria-label", "Eaten: " + (day.day || "") + " " + row[0] + " (" + USER + ")");
  line.className = "meal" + (box.checked ? " eaten" : "");
  box.onchange = function () {
    var list = eaten[week] || [];
    var at = list.indexOf(id);
    if (box.checked && at < 0) list.push(id);
    if (!box.checked && at > -1) list.splice(at, 1);
    eaten[week] = list;
    save();
    line.className = "meal" + (box.checked ? " eaten" : "");
    updateEaten();
  };

  var text = el("span", "mt");
  text.appendChild(el("span", "mk", row[0]));
  text.appendChild(el("span", "mv", row[1]));
  // In the Everyone view, show anyone who has a different meal in this slot.
  if (!person && ppl && day.people) {
    Object.keys(day.people).forEach(function (personKey) {
      var own = day.people[personKey];
      var dish = own && own[row[0].toLowerCase()];
      if (dish && ppl[personKey] && ppl[personKey].name) {
        var other = el("span", "ov");
        other.appendChild(el("b", null, ppl[personKey].name + ": "));
        other.appendChild(document.createTextNode(dish));
        text.appendChild(other);
      }
    });
  }
  line.appendChild(box);
  line.appendChild(text);

  var rateButton = el("button", "rate-btn");
  rateButton.type = "button";
  line.appendChild(rateButton);
  card.appendChild(line);
  var summary = el("p", "rate-sum");
  var rateBox = el("div", "rate-box");
  card.appendChild(summary);
  card.appendChild(rateBox);
  rateUI(id, (day.day || "") + " " + row[0].toLowerCase(), rateButton, summary, rateBox, row[1]);
}

// ---------- meals ----------

// The Meals view: the person picker, then one day: its meals and that person's snacks to tick,
// things to consider that day, the recipes for the day, and the person's eating guide and times.
function renderMeals() {
  var panel = $("meals");
  panel.textContent = "";
  panel.appendChild(mealsToggle());
  var w = PLAN.weeks[week];
  var ppl = PLAN.people || null;
  if (!w.meals || !w.meals.length) {
    panel.appendChild(el("p", "emptyline", "No meals are listed for this week."));
    return;
  }
  var who = pickWho(ppl);
  if (ppl) panel.appendChild(personSeg(ppl, who, renderMeals));
  var person = who !== "all" && ppl ? ppl[who] : null;

  var nav = dayNav(w.meals, renderMeals);
  panel.appendChild(nav.el);
  var dayInfo = mealDays(w, person, who, true)[nav.index];
  var day = dayInfo.d;

  var card = dayMealsCard(dayInfo, person, ppl);
  panel.appendChild(card);
  swipeDays(card, nav.step);

  var lines = dayConsiderations(day, person, ppl, who, nav.index);
  var advice = adviceBox("Today’s considerations" + (short(day.day) === TODAY ? "" : ": " + (FULLDAY[short(day.day)] || day.day)), lines);
  if (advice) panel.appendChild(advice);

  if (w.recipes && w.recipes.length) addDayRecipes(panel, w.recipes, dayInfo, person);

  if (person) {
    var guide = el("details", "exfold");
    guide.appendChild(el("summary", null, person.name + "’s guide, eating times and calendar"));
    var g = el("div");
    g.appendChild(personGuide(person, who));
    guide.appendChild(g);
    panel.appendChild(guide);
  }
}

// The card for one day on Meals: "3 of 5 eaten", then each meal with its tick and Rate button.
function dayMealsCard(dayInfo, person, ppl) {
  var day = dayInfo.d;
  var card = el("section", "day daycard");
  var count = el("p", "count");
  card.appendChild(count);
  var ids = dayInfo.rows.map(function (row) { return (day.day || "") + "|" + row[0]; });
  // Updates "3 of 5 eaten" after a meal is ticked.
  function updateEaten() {
    var done = (eaten[week] || []).filter(function (id) { return ids.indexOf(id) > -1; }).length;
    count.textContent = "";
    count.appendChild(el("b", null, done + " of " + ids.length + " eaten"));
    count.appendChild(el("span", null, "Tick once eaten"));
  }
  dayInfo.rows.forEach(function (row) {
    mealRow(card, day, row, person, ppl, updateEaten);
  });
  if (dayInfo.fasting.length) card.appendChild(el("p", "note2", fastingLine(dayInfo.fasting)));
  updateEaten();
  return card;
}

// Things to consider on a day, as a list of lines: the plan's note for the day, training that day
// and what it means for snacks, and a tip (a different one each day: `dayIndex` picks it).
function dayConsiderations(day, person, ppl, who, dayIndex) {
  var lines = [];
  if (day.note) lines.push(day.note);
  if (person) {
    var exDay = exDayOf(week, who, day.day);
    if (exDay) {
      var sessions = sessionLines(exDay);
      lines.push(sessions.length ? "Exercise today: " + sessions.join("; ") : "No exercise planned today: a rest day.");
      // Snacks that follow strength training, leaving out any not eaten on this day of the week
      // (someone who goes without snacks on a fast day).
      var tied = (person.snacks || []).filter(function (s) { return s && s.exercise === "strength" && (!Array.isArray(s.days) || s.days.indexOf(short(day.day)) > -1); });
      if (tied.length) {
        lines.push(isWeightsDay(exDay)
          ? "Strength day: " + tied.map(function (s) { return s.what; }).join(", ") + " is in today’s snacks, after training."
          : "No weights today, so " + tied.map(function (s) { return s.what.replace(/^\d+\s*ml\s+/, ""); }).join(", ") + " is left out.");
      }
    }
    if (person.tips && person.tips.length) lines.push("Tip: " + person.tips[dayIndex % person.tips.length]);
  } else if (ppl) {
    lines.push("Pick a person above to see their snacks and notes for the day.");
  }
  return lines;
}

// Adds the recipes to the Meals view: the ones for the dishes on this day, then the rest of the
// week's in a fold. Amounts are for `forPerson`, or for everyone when it is null.
function addDayRecipes(panel, recipes, dayInfo, forPerson) {
  var dishes = dayInfo.rows.map(function (row) { return String(row[1]).replace(/ \(packed\)$/, ""); });
  var today = recipes.filter(function (r) { return dishes.indexOf(r.name) > -1; });
  var rest = recipes.filter(function (r) { return dishes.indexOf(r.name) < 0; });
  var qty = forPerson ? " (amounts for " + forPerson.name + ")" : " (amounts for everyone)";
  if (today.length) {
    panel.appendChild(el("h2", "rh", "Today’s recipes" + qty));
    var list = el("ul", "recipes");
    today.forEach(function (r) { list.appendChild(recipeItem(r, forPerson)); });
    panel.appendChild(list);
  }
  if (rest.length) {
    var fold = el("details", "exfold");
    fold.appendChild(el("summary", null, (today.length ? "The rest of this week’s recipes" : "This week’s recipes") + qty));
    var inner = el("div");
    var more = el("ul", "recipes");
    rest.forEach(function (r) { more.appendChild(recipeItem(r, forPerson)); });
    inner.appendChild(more);
    fold.appendChild(inner);
    panel.appendChild(fold);
  }
}

// ---------- recipe amounts ----------

// A household amount, rounded so it is easy to measure: whole numbers for counted things,
// the nearest 5 or 10 for grams and millilitres, and the nearest quarter for anything else.
function fq(v, label, isWhole) {
  if (isWhole) return String(Math.max(1, Math.round(v)));
  if (/^(g|ml)\b/.test(label)) {
    var step = v < 50 ? 5 : 10;
    return String(Math.max(5, Math.round(v / step) * step));
  }
  var rounded = Math.max(0.5, Math.round(v * 4) / 4);
  var whole = Math.floor(rounded);
  var part = { 0: "", 0.25: "¼", 0.5: "½", 0.75: "¾" }[rounded - whole];
  return (whole ? String(whole) : "") + part;
}

// A number as a whole number and the nearest simple fraction (⅕ ¼ ⅓ ½ ⅔ ¾): 1.3 gives "1⅓".
function frac(v) {
  var FRACTIONS = [[0, ""], [0.2, "⅕"], [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"], [1, ""]];
  var whole = Math.floor(v);
  var rest = v - whole;
  var best = FRACTIONS[0];
  FRACTIONS.forEach(function (x) {
    if (Math.abs(rest - x[0]) < Math.abs(rest - best[0])) best = x;
  });
  if (best[0] === 1) {   // nearer the next whole number
    whole++;
    best = FRACTIONS[0];
  }
  return (whole ? String(whole) : "") + best[1];
}

// One person's share of a batch recipe. Small amounts get proper fractions (⅕ to ¾) instead of
// rounding up to ½ or 1, and part of a can or jar is shown in grams, e.g. "about 130 g red kidney beans".
function personQty(v, label, isWhole) {
  var can = /^× (\d+) ?(g|ml) (?:can|jar|tin) (?:of )?(.+)$/.exec(label);   // "× 400 g can chickpeas"
  if (can && v < 0.9) {
    var amount = v * +can[1];
    var step = amount < 50 ? 5 : 10;
    return "about " + Math.max(5, Math.round(amount / step) * step) + " " + can[2] + " " + can[3] + " (from a " + can[1] + " " + can[2] + " can)";
  }
  if (/^(g|ml)\b/.test(label)) return fq(v, label, isWhole) + " " + label;
  // "1 can", "½ tomato": one or less reads as singular.
  var singular = function (x) {
    return x.replace(/\b(tomato|egg|wrap|sausage|can|slice)(e?s)\b/, "$1");
  };
  if (isWhole && v >= 0.75) {
    var n = Math.round(v);
    return n + " " + (n === 1 ? singular(label) : label);
  }
  if (v < 0.15) return "a little " + label.replace(/^(× )/, "");
  return frac(v) + " " + (v < 1.1 ? singular(label) : label);
}

// One recipe in the list. A recipe can be a line of text ("Name: details") or a full recipe
// object, shown as a fold-out with ingredients, method and notes. With `forPerson`, the amounts
// are one serve for that person (q × portion ÷ units).
function recipeItem(r, forPerson) {
  var item = el("li", "rec");
  if (typeof r === "string") {
    var p = el("p");
    var colon = r.indexOf(": ");
    if (colon > 0) {
      p.appendChild(el("strong", null, r.slice(0, colon + 1)));
      p.appendChild(document.createTextNode(r.slice(colon + 1)));
    } else {
      p.textContent = r;
    }
    item.appendChild(p);
    return item;
  }

  var fold = el("details");
  var summary = el("summary");
  summary.appendChild(el("strong", null, r.name));
  var makes = forPerson ? ("1 serve for " + forPerson.name) : r.makes;
  if (makes) summary.appendChild(el("span", "mk2", " · " + makes));
  fold.appendChild(summary);

  var ingredients = r.ingredients;
  if (r.items && r.items.length) {
    ingredients = r.items.map(function (it) {
      if (forPerson && r.units) return personQty(it.q * forPerson.portion / r.units, it.l, it.i);
      return fq(it.q, it.l, it.i) + " " + it.l;
    });
  }
  if (ingredients && ingredients.length) {
    fold.appendChild(el("h4", null, "Ingredients"));
    var list = el("ul", "bul");
    ingredients.forEach(function (x) { list.appendChild(el("li", null, x)); });
    fold.appendChild(list);
  }
  if (r.pantry && r.pantry.length) {
    fold.appendChild(el("p", "note2", "Pantry: " + r.pantry.join(", ") + ". Oil, salt, pepper and dried spices as needed."));
  } else {
    fold.appendChild(el("p", "note2", "Oil, salt, pepper and dried spices as needed."));
  }
  if (r.steps && r.steps.length) {
    fold.appendChild(el("h4", null, "Method"));
    var steps = el("ol", "steps");
    // The leftovers step only makes sense for the whole household's batch.
    var allSteps = r.steps.concat((!forPerson && r.leftoverStep) ? [r.leftoverStep] : []);
    allSteps.forEach(function (x) { steps.appendChild(el("li", null, x)); });
    fold.appendChild(steps);
  }
  if (r.kid) fold.appendChild(el("p", "kid", (kidName() + "'s version: ") + r.kid));
  if (!forPerson) {
    (r.others || []).forEach(function (x) { fold.appendChild(el("p", "note2", x)); });
  }
  item.appendChild(fold);
  return item;
}
