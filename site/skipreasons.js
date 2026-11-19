// Why someone didn't have a planned meal ("Didn't have it?" in a meal's Rate or skip box). One
// list for everyone: the Meals tab shows these buttons, the server keeps only these keys, and the
// weekly "How the week went" page and the next plan's writer read them.
//
// Pages load it with <script src="skipreasons.js"> (it sets window.SkipReasons); the server loads
// it with require(), the same way it loads energy.js.
(function () {
  "use strict";

  // [key, what the button says]. The key is what is saved; the words can change.
  var REASONS = [
    ["time", "No time"],
    ["effort", "Too much effort"],
    ["missing", "Missing ingredients"],
    ["out", "Ate out or takeaway"],
    ["mood", "Didn’t feel like it"],
    ["refused", "Didn’t want to eat it"],
    ["hungry", "Not hungry"],
    ["other", "Something else"],
  ];

  // The words for a reason's key, like "No time", or "" for an unknown key.
  function label(key) {
    for (var i = 0; i < REASONS.length; i++) if (REASONS[i][0] === key) return REASONS[i][1];
    return "";
  }

  // Whether `key` is one of the reasons.
  function valid(key) {
    return label(key) !== "";
  }

  var SkipReasons = { REASONS: REASONS, label: label, valid: valid };
  if (typeof module === "object" && module.exports) module.exports = SkipReasons;
  else window.SkipReasons = SkipReasons;
})();
