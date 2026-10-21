import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('all local HTML assets resolve under the GitHub Pages project path', async () => {
  const html = await read('index.html');
  const references = [...html.matchAll(/(?:src|href)="(\.[^"]+)"/g)].map((match) => match[1]);
  for (const ref of references) {
    if (ref === './') continue;
    assert.equal(new URL(ref, 'https://example.github.io/webvm2.0/').pathname.startsWith('/webvm2.0/'), true);
    await access(new URL(ref, root));
  }
});

test('the isolation service worker preserves responses and adds the actual VM prerequisites', async () => {
  const handlers = new Map();
  const scope = vm.createContext({
    self: {location: {origin: 'https://example.github.io'}, addEventListener: (type, handler) => handlers.set(type, handler)},
    URL, Headers, Response,
    fetch: async () => new Response('debian-app', {status: 200, headers: {'Content-Type': 'text/javascript'}})
  });
  vm.runInContext(await read('service-worker.js'), scope);
  let result;
  handlers.get('fetch')({request: {url: 'https://example.github.io/webvm2.0/app.js'}, respondWith: (promise) => { result = promise; }});
  const response = await result;
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(response.headers.get('Content-Type'), 'text/javascript');
  assert.equal(await response.text(), 'debian-app');
  let interceptedExternalRuntime = false;
  handlers.get('fetch')({request: {url: 'https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js'}, respondWith: () => { interceptedExternalRuntime = true; }});
  assert.equal(interceptedExternalRuntime, false);
});

test('service worker preserves 404s and redirects instead of masking them as successful app content', async () => {
  const handlers = new Map();
  const scope = vm.createContext({
    self: {location: {origin: 'https://example.github.io'}, addEventListener: (type, handler) => handlers.set(type, handler)},
    URL, Headers, Response,
    fetch: async () => new Response('not found', {status: 404})
  });
  vm.runInContext(await read('service-worker.js'), scope);
  let promise;
  const event = {request: {url: 'https://example.github.io/webvm2.0/missing.js'}, respondWith: (response) => { promise = response; }};
  handlers.get('fetch')(event);
  assert.equal((await promise).status, 404);
  scope.fetch = async () => ({type: 'basic', status: 200, redirected: true, url: 'https://example.github.io/webvm2.0/', headers: new Headers()});
  handlers.get('fetch')(event);
  const redirected = await promise;
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), 'https://example.github.io/webvm2.0/');
});

test('HTML has unique IDs and every statically referenced app element exists', async () => {
  const html = await read('index.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'duplicate IDs would route actions to the wrong panel');
  const app = await read('app.js');
  for (const [, id] of app.matchAll(/(?<!\$)\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `missing element ${id}`);
});
