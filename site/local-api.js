// The phone app's on-device "server" lives in a file with this name in the app.
//
// The phone app (github.com/scoregie/family-health-planner-app) uses these same pages. Its own
// local-api.js answers the pages' /api calls on the phone and sets window.PHONE, which
// edition.js and the pages use to switch to the phone's wording and features.
// The web version has a real server, so this file only says it isn't the phone.
window.PHONE = null;
