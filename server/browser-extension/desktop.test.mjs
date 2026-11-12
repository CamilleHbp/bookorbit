import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const template = await readFile(new URL('desktop.js', import.meta.url), 'utf8');
const wait = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  throw new Error('Collector did not initialize');
};

async function storyFixture() {
  const dom = new JSDOM('<body>Cloudflare verification</body>', { url: 'https://www.fanfiction.net/s/123/1/' });
  const { window } = dom;
  const source = template.replace(
    '/* STORY */',
    `window.collector = { runtime, storage }; runtime.onMessage.addListener((request, sender, respond) => respond({ active: true }));`,
  );
  const context = vm.createContext({
    window,
    location: window.location,
    document: window.document,
    sessionStorage: window.sessionStorage,
    indexedDB: new IDBFactory(),
    Blob,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, context);
  await wait(() => window.collector);
  await window.collector.storage.set({
    'story:123:info': { title: 'Story', author: 'Writer', count: 1 },
    'story:123:1': { heading: 'One', body: '<p>Text</p>' },
  });
  const messages = [];
  const library = { closed: false, postMessage: (data, origin) => messages.push({ data, origin }) };
  window.dispatchEvent(
    new window.MessageEvent('message', { origin: 'https://books.camille.studio', source: library, data: { type: 'bookorbit:collect', id: '123' } }),
  );
  await new Promise(setImmediate);
  return { window, messages, library, runtime: window.collector.runtime };
}

test('desktop initializes during verification and sends a complete collection to the requesting library', async () => {
  const f = await storyFixture();
  const result = f.runtime.sendMessage({ type: 'download', url: 'blob:test' });
  await wait(() => f.messages.length);
  const { data, origin } = f.messages[0];
  assert.equal(origin, 'https://books.camille.studio');
  assert.equal(JSON.parse(await data.file.text()).chapters.length, 1);
  let finished = false;
  result.then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  f.window.dispatchEvent(
    new f.window.MessageEvent('message', {
      origin,
      source: f.library,
      data: { type: 'bookorbit:collection-result', id: '123', requestId: data.requestId },
    }),
  );
  assert.match((await result).message, /Update submitted/);
});

test('desktop reports library rejection and allows another transfer', async () => {
  const f = await storyFixture();
  const result = f.runtime.sendMessage({ type: 'download', url: 'blob:test' });
  const rejected = assert.rejects(result, /Open matching book/);
  await wait(() => f.messages.length);
  const { data, origin } = f.messages[0];
  f.window.dispatchEvent(
    new f.window.MessageEvent('message', {
      origin,
      source: f.library,
      data: { type: 'bookorbit:collection-result', id: '123', requestId: data.requestId, error: 'Open matching book' },
    }),
  );
  await rejected;
  const retry = f.runtime.sendMessage({ type: 'download', url: 'blob:test' });
  await wait(() => f.messages.length === 2);
  const next = f.messages[1].data;
  f.window.dispatchEvent(
    new f.window.MessageEvent('message', {
      origin,
      source: f.library,
      data: { type: 'bookorbit:collection-result', id: '123', requestId: next.requestId },
    }),
  );
  assert.equal((await retry).downloadId, 0);
});

test('desktop library accepts ordinary matching story links, submits once, and acknowledges receipt', async () => {
  const dom = new JSDOM(
    '<body><form><label><input type="file" data-bookorbit-story="https://www.fanfiction.net/s/123/1/"></label><button type="submit">Update</button></form><a id="story" href="https://www.fanfiction.net/s/123/1/">Open story</a></body>',
    { url: 'https://books.camille.studio/book/42' },
  );
  const { window } = dom;
  const replies = [];
  let submitted = 0;
  window.document.querySelector('form').requestSubmit = () => {
    submitted++;
  };
  const popup = { closed: false, location: { replace() {} }, postMessage: (data, origin) => replies.push({ data, origin }) };
  window.open = () => popup;
  const source = template.replace('/* PREPARE */', 'async function prepareStoryUpdate() { return "Ready"; }');
  const context = vm.createContext({
    window,
    location: window.location,
    document: window.document,
    sessionStorage: window.sessionStorage,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
    Event: window.Event,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    console,
  });
  vm.runInContext(source, context);
  await wait(() => window.document.querySelector('[data-collected-file]'));
  window.document.querySelector('#story').click();
  const file = new Blob([
    JSON.stringify({
      version: 1,
      id: '123',
      info: { title: 'Story', author: 'Writer', count: 1 },
      chapters: [{ heading: 'One', body: '<p>Text</p>' }],
    }),
  ]);
  window.dispatchEvent(
    new window.MessageEvent('message', {
      origin: 'https://www.fanfiction.net',
      source: popup,
      data: { type: 'bookorbit:collection', id: '123', requestId: 'request-1', file },
    }),
  );
  await wait(() => replies.length);
  assert.equal(submitted, 1);
  assert.equal(replies[0].data.type, 'bookorbit:collection-result');
  assert.equal(replies[0].data.requestId, 'request-1');
  assert.equal(replies[0].data.error, undefined);
});
