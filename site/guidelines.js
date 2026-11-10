// The "Healthy-eating guidelines" card on the Macros tab. It compares one person's week with
// the guidelines of Australia, New Zealand, the UK, Japan or Korea (from guidelines.json),
// using the food groups worked out for each dish (the plan's "groups" block, made by
// tools/estimate_groups.py). Then it suggests what to add for anything that falls short.
//
// The main page calls Guidelines.card({...}) and puts the result under the macros card.
"use strict";
var Guidelines = (function () {
  var data = null;        // guidelines.json, once loaded
  var loading = null;     // the fetch of guidelines.json, so it only happens once
  var profiles = {};      // person key -> their About me answers (or {} if we can't see them)
  // The locale for numbers ("en-GB" and so on), from the household's country.
  function LOC() { return window.Appearance ? Appearance.locale() : "en-AU"; }

  // Makes a new element, with an optional class name and text.
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // One decimal place, without a trailing ".0": 4 -> "4", 4.25 -> "4.3".
  function num(n) {
    return String(Math.round(n * 10) / 10);
  }

  // Loads guidelines.json (only once, however many cards ask for it).
  function loadData() {
    if (!loading) {
      loading = fetch("guidelines.json", { cache: "no-cache" })
        .then(function (r) { if (!r.ok) throw new Error("guidelines.json " + r.status); return r.json(); })
        .then(function (d) { data = d; return d; });
    }
    return loading;
  }

  // A person's About me answers. People can only see their own (admins can see everyone's),
  // so anyone else's comes back empty and the card uses average adult numbers.
  function loadProfile(key) {
    if (profiles[key]) return Promise.resolve(profiles[key]);
    return fetch("/api/profile?person=" + encodeURIComponent(key), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (p) {
        profiles[key] = (p && p.answers) || {};
        return profiles[key];
      });
  }

  // ---------- adding up the week ----------

  // Each day's food groups for one person: [{veg, fruit, ..., fishMeals, oilyMeals, kj}].
  // Meals are scaled by the person's portion; snacks are already written for them, so they aren't.
  function dayTotals(days, portion, groupsOf) {
    return days.map(function (day) {
      var t = { kj: day.tot ? day.tot.kj : 0, fishMeals: 0, oilyMeals: 0, known: 0, leg: 0 };
      day.rows.forEach(function (row) {
        if (row.optional) return;
        var g = groupsOf(row[1]);
        if (!g) return;
        var factor = row.snack ? 1 : portion;
        t.known++;
        Object.keys(g).forEach(function (k) { t[k] = (t[k] || 0) + g[k] * factor; });
        if ((g.fish || 0) * factor >= 50) t.fishMeals++;
        if ((g.oily || 0) * factor >= 50) t.oilyMeals++;
      });
      return t;
    });
  }

  // The average of field `f` over the days, or computed per day with f(day).
  function avg(days, f) {
    if (!days.length) return 0;
    var get = typeof f === "function" ? f : function (d) { return d[f] || 0; };
    return days.reduce(function (sum, d) { return sum + get(d); }, 0) / days.length;
  }

  // How much of each group a day has, in the country's own units.
  var MEASURE = {
    au: { veg: "veg", fruit: "fruit", grain: "grain", protein: "protein", dairy: "dairy" },
    nz: { veg: "veg", fruit: "fruit", grain: "grain" },
    uk: { fv: function (d) { return ((d.fv || 0) + Math.min(d.leg || 0, 80)) / 80; } },   // beans count once a day
    jp: {
      grain: function (d) { return (d.gc || 0) / 40; },
      side: function (d) { return (d.side || 0) / 70; },
      main: function (d) { return (d.mp || 0) / 6; },
      dairy: function (d) { return (d.ca || 0) / 100; },
      fruit: function (d) { return (d.fruit || 0) * 150 / 100; },
    },
    kr: { grain: "grain", veg: "veg", fruit: "fruit", dairy: "dairy", protein: "protein" },
  };

  // ---------- targets ----------

  // The row of a country's table that fits this person (by age and sex), and a note about it.
  function targetRow(country, answers) {
    var age = +answers.age || null;
    var sex = answers.sex === "Male" ? "male" : answers.sex === "Female" ? "female" : null;
    var rows = country.targets || [];
    var note = "";
    var forAge = rows.filter(function (r) { return age && age >= r.age[0] && age <= r.age[1]; });
    if (!forAge.length) {
      // No age (or outside the table): use adults.
      forAge = rows.filter(function (r) { return r.age[0] <= 19 && r.age[1] >= 19; });
      if (!forAge.length) forAge = rows.slice(-1);
      note = age ? "These guidelines are written for ages " + forAge[0].age[0] + " to " + forAge[0].age[1] + ", so their numbers are used. " : "Using the numbers for adults. Add your age in About me for a closer match. ";
    }
    var row = forAge.filter(function (r) { return r.sex === sex; })[0] || forAge.filter(function (r) { return r.sex === "any"; })[0];
    if (!row && forAge.length > 1) {
      // Sex not given: halfway between the two rows, to the nearest half serve.
      row = { age: forAge[0].age, check: forAge.some(function (r) { return r.check; }) };
      country.groups.forEach(function (g) {
        row[g] = Math.round((forAge[0][g] + forAge[1][g])) / 2;
      });
      note += "Halfway between the numbers for men and women. Add your sex in About me for a closer match. ";
    }
    row = row || forAge[0];
    var label = row.sex === "male" ? "men" : row.sex === "female" ? "women" : "people";
    if (row.age[1] < 19) label = row.sex === "male" ? "boys" : row.sex === "female" ? "girls" : "children";
    var who = row.age[1] >= 120
      ? (row.sex === "any" ? "everyone " + row.age[0] + " and over" : label + " " + row.age[0] + " and over")
      : label + " " + row.age[0] + " to " + row.age[1];
    return { row: row, note: note, who: who };
  }

  // Japan's amounts depend on the energy a person needs, so pick the band from their planned kJ.
  function japanBand(country, kj) {
    var kcal = kj / 4.184;
    var band = country.bands.filter(function (b) { return kcal >= b.kcal[0] && kcal < b.kcal[1]; })[0];
    if (!band) band = kcal < country.bands[0].kcal[0] ? country.bands[0] : country.bands[country.bands.length - 1];
    return band;
  }

  // ---------- drawing ----------

  // One group: its name, "4.2 of 6 serves", a meter, and whether it meets the guideline.
  function groupRow(label, value, low, high, unit) {
    var row = el("div", "gl-row");
    var top = el("div", "gl-top");
    top.appendChild(el("span", "gl-name", label));
    var target = high && high !== low ? num(low) + " to " + num(high) : num(low);
    var amount = el("span", "gl-val");
    amount.appendChild(el("b", null, num(value)));
    amount.appendChild(document.createTextNode(" of " + target + " " + unit));
    top.appendChild(amount);
    row.appendChild(top);

    // The meter: the bar is the amount; the tick (or shaded band) is the target.
    var max = Math.max(value, high || low) * 1.15 || 1;
    var meter = el("div", "gl-meter");
    meter.setAttribute("aria-hidden", "true");
    var fill = el("i", "gl-fill");
    fill.style.width = Math.min(100, value / max * 100) + "%";
    meter.appendChild(fill);
    if (high && high !== low) {
      var band = el("i", "gl-band");
      band.style.left = low / max * 100 + "%";
      band.style.width = (high - low) / max * 100 + "%";
      meter.appendChild(band);
    }
    var tick = el("i", "gl-tick");
    tick.style.left = low / max * 100 + "%";
    meter.appendChild(tick);
    row.appendChild(meter);

    var state;
    if (value < low * 0.95) state = ["below", "↓", "Below by " + num(low - value)];
    else if (high && value > high * 1.05) state = ["above", "↑", "Above by " + num(value - high)];
    else state = ["meets", "✓", high ? "In range" : "Meets it"];
    var status = el("span", "gl-status " + state[0]);
    status.appendChild(el("span", "gl-icon", state[1]));
    status.appendChild(document.createTextNode(" " + state[2]));
    top.appendChild(status);
    row.state = state[0];
    return row;
  }

  // A list in a fold-out section ("Key messages", "Limits", "Sources").
  function fold(title, items, links) {
    var d = el("details", "gl-fold");
    d.appendChild(el("summary", null, title));
    var list = el("ul");
    items.forEach(function (item) {
      var li = el("li");
      if (links) {
        var a = el("a", null, item.label);
        a.href = item.url;
        a.target = "_blank";
        a.rel = "noopener";
        li.appendChild(a);
      } else {
        li.textContent = item;
      }
      list.appendChild(li);
    });
    d.appendChild(list);
    return d;
  }

  // The country buttons.
  function countryPicker(current, pick) {
    var seg = el("div", "seg gl-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Which country's guidelines");
    data.countries.forEach(function (c) {
      var b = el("button", "btn", c.name);
      b.type = "button";
      b.setAttribute("aria-pressed", c.id === current);
      b.onclick = function () { pick(c.id); };
      seg.appendChild(b);
    });
    return seg;
  }

  // Fills the card for one country.
  function fill(box, o, countryId, answers) {
    box.textContent = "";
    var country = data.countries.filter(function (c) { return c.id === countryId; })[0] || data.countries[0];
    var head = el("div", "mac-head");
    head.appendChild(el("h3", null, "Healthy-eating guidelines · " + o.person.name));
    box.appendChild(head);
    box.appendChild(countryPicker(country.id, function (id) {
      try { localStorage.setItem("coles-plan-guide-" + o.who, id); } catch (e) {}
      fill(box, o, id, answers);
    }));

    var days = dayTotals(o.days, o.portion, o.groupsOf).filter(function (d) { return d.known; });
    if (!days.length) {
      box.appendChild(el("p", "mac-note", "There are no food-group estimates for this week's meals yet." +
        (o.isAdmin ? " Run tools/estimate_groups.py on the server to add them (see tools/README.md)." : "")));
      return;
    }

    var measure = MEASURE[country.id];
    var intro = el("p", "gl-intro");
    var rows = el("div", "gl-rows");
    var below = [];
    var note = "";

    if (country.variety) {
      // Korea: every food group, every day.
      intro.textContent = "Korea’s guidelines ask for a variety of foods every day. Days this week with each food group:";
      country.groups.forEach(function (g) {
        var withIt = days.filter(function (d) { return (d[g] || 0) >= 0.3; }).length;
        var r = groupRow(data.groups[g].short, withIt, days.length, null, "days");
        rows.appendChild(r);
        if (r.state === "below") below.push(g);
      });
    } else if (country.bands) {
      // Japan: servings of dishes, by energy band.
      var kj = avg(days, "kj");
      var band = japanBand(country, kj);
      intro.textContent = "Daily average this week, in servings (SV) of the Spinning Top for about " +
        Math.round(band.kcal[0]).toLocaleString(LOC()) + " to " + Math.round(band.kcal[1]).toLocaleString(LOC()) + " kcal a day (this week’s plan: about " +
        Math.round(kj / 4.184).toLocaleString(LOC()) + " kcal).";
      country.groups.forEach(function (g) {
        var r = groupRow(data.groups[g].short, avg(days, measure[g]), band[g][0], band[g][1], "SV");
        rows.appendChild(r);
        if (r.state === "below") below.push(g);
      });
      if (band.check) note += "The serving numbers for this energy band are still to be confirmed against the official chart. ";
    } else {
      var t = targetRow(country, answers);
      intro.textContent = "Daily average this week, compared with " + country.name + "’s guidelines for " + t.who + ".";
      note += t.note;
      country.groups.forEach(function (g) {
        var r = groupRow(data.groups[g].short, avg(days, measure[g]), t.row[g], null, country.unit);
        rows.appendChild(r);
        if (r.state === "below") below.push(g);
      });
      if (t.row.check) note += "Some of these numbers are from a secondary source and are still to be confirmed against the official table. ";
    }
    box.appendChild(intro);
    box.appendChild(rows);

    // The UK's extra checks: red and processed meat, and fish twice a week.
    var ideas = [];
    if (country.checks) {
      var red = avg(days, "red");
      var fish = days.reduce(function (s, d) { return s + d.fishMeals; }, 0) * 7 / days.length;
      var oily = days.reduce(function (s, d) { return s + d.oilyMeals; }, 0) * 7 / days.length;
      var extra = el("ul", "gl-checks");
      // One line of the comparison: a tick if the week meets the guideline, "!" if it falls short.
      function check(ok, text) {
        var li = el("li", ok ? "meets" : "below");
        li.appendChild(el("span", "gl-icon", ok ? "✓" : "!"));
        li.appendChild(document.createTextNode(" " + text));
        extra.appendChild(li);
      }
      check(red <= country.checks.redMeatMaxG, "Red and processed meat: about " + Math.round(red) + " g a day (cooked). The guide: 70 g or less.");
      check(fish >= country.checks.fishPerWeek, "Fish: " + num(fish) + " meals a week. The guide: at least 2.");
      check(oily >= country.checks.oilyFishPerWeek, "Oily fish: " + num(oily) + " meals a week. The guide: at least 1 (salmon, sardines, mackerel or trout).");
      box.appendChild(extra);
      if (red > country.checks.redMeatMaxG) ideas.push(data.ideas.redmeat[0]);
      if (fish < country.checks.fishPerWeek || oily < country.checks.oilyFishPerWeek) ideas.push(data.ideas.fish[0]);
    }

    // Ideas for the two groups that fall furthest short.
    below.slice(0, 2).forEach(function (g) {
      if (data.ideas[g]) ideas.push(data.ideas[g][0]);
    });
    if (ideas.length) {
      var ideaBox = el("div", "gl-ideas");
      ideaBox.appendChild(el("b", null, "Ideas"));
      var list = el("ul");
      ideas.forEach(function (i) { list.appendChild(el("li", null, i)); });
      ideaBox.appendChild(list);
      box.appendChild(ideaBox);
    }

    if (country.note) note += country.note + " ";
    if (days.length < o.days.length) note += "Averaged over the " + days.length + " days with estimates. ";
    note += "Estimated from the recipes and snacks, scaled to " + o.person.name + "’s portion. Salt, saturated fat, sugar and fibre can’t be worked out from the recipes yet, so check the limits below.";
    box.appendChild(el("p", "mac-note", note));

    box.appendChild(fold("Key messages", country.messages));
    if (country.serveSizes) {
      box.appendChild(fold("What counts as one " + (country.unit === "SV" ? "serving" : country.unit.replace(/s$/, "")),
        Object.keys(country.serveSizes).map(function (g) { return data.groups[g].short + ": " + country.serveSizes[g]; })));
    }
    if (country.limits && country.limits.length) box.appendChild(fold("Limits to keep in mind", country.limits));
    var sources = fold("Sources", country.sources, true);
    sources.appendChild(el("p", "mac-note", country.title + ". " + (country.status || "") + " Checked " + data.checked + "."));
    box.appendChild(sources);
    box.appendChild(el("p", "mac-note", "A guide only: advice from your doctor or dietitian comes first."));
  }

  // The card for one person and week. Shows "Loading…" until guidelines.json and their answers arrive.
  //   o.days      the week from mealDays() (each day's rows, with snacks marked row.snack)
  //   o.person    the plan's entry for the person ({name, portion, ...}), o.who their plan key
  //   o.portion   their portion, o.groupsOf(dish) the food groups for a dish (or null)
  //   o.profileKey   the key for /api/profile, o.isAdmin
  function card(o) {
    var box = el("section", "mac gl");
    box.appendChild(el("p", "mac-note", "Loading the healthy-eating guidelines…"));
    Promise.all([loadData(), loadProfile(o.profileKey)]).then(function (got) {
      var answers = got[1];
      var saved = null;
      try { saved = localStorage.getItem("coles-plan-guide-" + o.who); } catch (e) {}
      // The About me answer can list several countries (or be one name, from before). The first one is shown.
      var chosen = [].concat(answers.guidelines || []);
      var fromAnswers = chosen.map(function (name) {
        return data.countries.filter(function (c) { return c.name === name; })[0];
      }).filter(Boolean)[0];
      fill(box, o, saved || (fromAnswers && fromAnswers.id) || (window.Appearance ? Appearance.region().guidelines : "au"), answers);
    }).catch(function (e) {
      box.textContent = "";
      box.appendChild(el("p", "mac-note", "Could not load the healthy-eating guidelines: " + e.message));
    });
    return box;
  }

  return { card: card, _dayTotals: dayTotals, _targetRow: targetRow };
})();
