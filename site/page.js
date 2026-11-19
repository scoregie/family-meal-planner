// The small helpers every page uses, kept here once so the pages can't drift apart:
//   $(id)               finds an element on the page by its id
//   el(tag, cls, text)  makes a new element
//   api(method, url, body, options)  talks to the server and gives back its JSON answer
//   toLogin()           goes to the login page, coming back to the same place afterwards
//   status(text, isError)  shows a short message in the page's #status box
// Each page loads this file before its own script. (In the phone app, local-api.js answers the
// server calls on the phone instead, and nobody is ever logged out.)

// Finds an element by its id.
function $(id) {
  return document.getElementById(id);
}

// Makes an element, with an optional class name and text: el("p", "note", "Hello").
function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// Asks the server for something, or sends it a change, and gives back its answer (JSON).
// A failed request throws an Error with the server's message (and its .status, like 409).
// Someone who has been logged out goes to the login page (except on the login page itself).
// `options`: {keepalive: true} lets a save finish while the page closes; {from: "files"} marks an
// upload-page request, which the server's uploads code asks for.
function api(method, url, body, options) {
  options = options || {};
  var request = { method: method, cache: "no-store", headers: { "X-Requested-With": options.from || "app" } };
  if (body != null) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(body);
  }
  if (options.keepalive) request.keepalive = true;
  return fetch(url, request).then(function (response) {
    if (response.status === 401 && !/^\/login/.test(location.pathname)) {
      toLogin();
      var out = new Error("Please log in again.");
      out.loginNeeded = true;
      out.status = 401;
      throw out;
    }
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (response.ok) return data;
      var error = new Error(data.error || "Something went wrong (" + response.status + "). Try again.");
      error.status = response.status;
      throw error;
    });
  });
}

// Goes to the login page, coming back to this same place afterwards.
function toLogin() {
  location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
}

// Shows a short message in the page's #status box, read out by screen readers. Errors stay until
// tapped; other messages go after 5 seconds. The box is emptied first and filled a moment later,
// so a screen reader announces the same message twice in a row.
function status(text, isError) {
  var s = $("status");
  clearTimeout(status.timer);
  clearTimeout(status.fill);
  s.className = "status" + (isError ? " err" : "");
  s.textContent = "";
  s.onclick = function () { s.textContent = ""; };
  status.fill = setTimeout(function () {
    s.textContent = text;
    if (!isError) status.timer = setTimeout(function () { s.textContent = ""; }, 5000);
  }, 50);
}
