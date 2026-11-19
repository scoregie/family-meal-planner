// Shows or hides the parts of a page that differ between the web version and the phone app.
//
// The pages are shared with the phone app. Before this file runs, local-api.js sets window.PHONE
// in the phone app (the web's local-api.js leaves it null). In a page:
//   data-web-only     shown only on the web version (logins, AI, Apple Health sync, uploads)
//   data-phone-only   shown only in the phone app (like Backup in Settings)
//   data-phone="..."  the words to show instead in the phone app
// Scripts check window.PHONE for anything they draw themselves.
(function () {
  var phone = !!window.PHONE;
  document.documentElement.classList.toggle("phone", phone);
  // Hidden with a style rule, so a script that shows a box later can't show a web-only part.
  var style = document.createElement("style");
  style.textContent = "html.phone [data-web-only],html:not(.phone) [data-phone-only]{display:none!important}";
  document.head.appendChild(style);
  if (!phone) return;

  // Puts the phone's words in place of the web's.
  function useWords() {
    document.querySelectorAll("[data-phone]").forEach(function (el) { el.textContent = el.getAttribute("data-phone"); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", useWords);
  else useWords();
})();
