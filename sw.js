const CACHE = "metrognom-cache-v2";
const FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./patternEditor.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./sound/Real Drum Kit/BD.wav",
  "./sound/Real Drum Kit/SD.wav",
  "./sound/Real Drum Kit/HH.wav"
];

// Install
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(FILES))
  );
});

// Serve from cache
self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});
