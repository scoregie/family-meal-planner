// How much energy (in kilojoules) a serve of food has, from its macros. One rule for everyone:
// the Meals tab, Edit plan and the server's Progress numbers all use this file, so they agree.
//
// The rule, as docs/plan-format.md describes it: a plan's own "kj" wins; older plans that give
// "kcal" instead are converted (1 kcal = 4.184 kJ); otherwise it is worked out from the factors
// on Australian food labels (FSANZ): 17 kJ per gram of protein and of carbs, 37 kJ per gram of fat.
//
// Pages load it with <script src="energy.js"> (it sets window.Energy); the server loads it with
// require(), the same way it loads regions.js.
(function () {
  "use strict";

  var KJ_PER_KCAL = 4.184;

  // The kJ in a serve with macros like {p: 20, c: 45, f: 12} (grams), or {kj: 1500}, or {kcal: 360}.
  // Nothing given (or no macros at all) is 0.
  function kj(macros) {
    if (!macros || typeof macros !== "object") return 0;
    if (+macros.kj) return +macros.kj;
    if (+macros.kcal) return macros.kcal * KJ_PER_KCAL;
    return 17 * (+macros.p || 0) + 17 * (+macros.c || 0) + 37 * (+macros.f || 0);
  }

  var Energy = { KJ_PER_KCAL: KJ_PER_KCAL, kj: kj };
  if (typeof module === "object" && module.exports) module.exports = Energy;
  else window.Energy = Energy;
})();
