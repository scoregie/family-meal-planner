// Network first, falls back to the saved copy so the lists still open with no signal.
var CACHE="shopping-list-v19";
var ASSETS=["./","index.html","plan.json","guidelines.js","regions.js","appearance.js","fonts/fonts.css","guidelines.json","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png","logo.svg"];
self.addEventListener("install",function(e){
  // Skips anything that redirected (to the login page) so that never gets saved as the app.
  e.waitUntil(caches.open(CACHE).then(function(c){return Promise.all(ASSETS.map(function(a){
    return fetch(a,{cache:"no-cache"}).then(function(res){if(res.ok&&!res.redirected)return c.put(a,res);}).catch(function(){});
  }));}).then(function(){return self.skipWaiting();}));
});
self.addEventListener("activate",function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));
});
self.addEventListener("fetch",function(e){
  var r=e.request;
  if(r.method!=="GET"||new URL(r.url).origin!==location.origin||new URL(r.url).pathname.indexOf("/api/")>-1||/^\/(auth\/|login)/.test(new URL(r.url).pathname))return;
  e.respondWith(fetch(r).then(function(res){
    if(res&&res.ok&&!res.redirected){var cp=res.clone();caches.open(CACHE).then(function(c){c.put(r,cp);});}
    return res;
  }).catch(function(){return caches.match(r).then(function(m){return m||caches.match("index.html");});}));
});
