// Supply the cross-origin isolation headers required by SharedArrayBuffer on
// GitHub Pages, where custom response headers cannot be configured directly.
// Adapted from the Apache-2.0 WebVM service worker (Leaning Technologies).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // Do not intercept other origins. The hosted CheerpX runtime sets its own CORS
  // and resource policy headers; opaque responses cannot be reconstructed.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const response = await fetch(event.request);
    if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    // Keep redirects visible instead of returning a body under the wrong URL.
    if (response.redirected) return Response.redirect(response.url, 302);
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  })());
});
