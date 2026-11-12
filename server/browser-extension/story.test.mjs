import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as zip from '@zip.js/zip.js';
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const source = await readFile(new URL('story.js', import.meta.url), 'utf8');
const epubSource = await readFile(new URL('epub.js', import.meta.url), 'utf8');

async function fixture({ chapter = 1, count = 3, challenge = false, state = true, data = {}, rejectDownload = false } = {}) {
  const dom = new JSDOM('<body></body>');
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  function content() {
    window.document.body.innerHTML = `<div id="profile_top"><b>A &amp; B</b><a href="/u/42">Writer</a>Chapters: ${count}</div><select id="chap_select">${Array.from({ length: count }, (_, i) => `<option ${i + 1 === chapter ? 'selected' : ''}>Chapter ${i + 1}</option>`).join('')}</select><div id="storytext"><p>Chapter ${chapter} text<script>bad()</script></p></div>`;
  }
  if (!challenge) content();
  const values = { 'collect:123': state, ...data };
  const navigations = [];
  const downloads = [];
  const intervals = [];
  let listener;
  const context = vm.createContext({
    document: window.document,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    location: { pathname: `/s/123/${chapter}/`, assign: (url) => navigations.push(url) },
    chrome: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map((k) => [k, values[k]])),
          getKeys: async () => Object.keys(values),
          set: async (entries) => Object.assign(values, entries),
          remove: async (keys) => keys.forEach((k) => delete values[k]),
        },
      },
      runtime: {
        id: 'test',
        onMessage: {
          addListener: (fn) => {
            listener = fn;
          },
        },
        sendMessage: async (request) => {
          if (request.type === 'identity') return { tabId: 7 };
          downloads.push(request);
          return rejectDownload ? { error: 'Disk full' } : { downloadId: 42 };
        },
      },
    },
    buildStoryEpub: async () => ({ blob: new Blob(['EPUB']), info: values['story:123:info'] }),
    URL: { createObjectURL: () => 'blob:https://www.fanfiction.net/test', revokeObjectURL() {} },
    Date: class extends Date {
      static now() {
        return clock;
      }
    },
    setInterval: (fn) => intervals.push(fn),
    setTimeout() {},
  });
  let clock = 0;
  vm.runInContext(source, context);
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  await flush();
  return {
    values,
    navigations,
    downloads,
    document: window.document,
    content,
    async tick() {
      clock += 2500;
      intervals[0]();
      await flush();
    },
    async send(method) {
      const result = new Promise((resolve) => listener(method, { id: 'test' }, resolve));
      await flush();
      return result;
    },
  };
}

test('saves before navigating and resumes at the first missing chapter', async () => {
  const f = await fixture({ chapter: 2, data: { 'story:123:1': { body: 'saved' } } });
  assert.match(f.values['story:123:2'].body, /Chapter 2 text/);
  assert.doesNotMatch(f.values['story:123:2'].body, /bad/);
  assert.deepEqual(f.navigations, []);
  await f.tick();
  assert.deepEqual(f.navigations, ['/s/123/3/']);
});

test('waits through Cloudflare and resumes after content appears without a reload', async () => {
  const f = await fixture({ challenge: true });
  await f.tick();
  assert.deepEqual(f.navigations, []);
  assert.match(f.document.body.textContent, /Complete Cloudflare verification/);
  f.content();
  await f.tick();
  assert.ok(f.values['story:123:1']);
  await f.tick();
  assert.deepEqual(f.navigations, ['/s/123/2/']);
});

test('pause survives page loads and resume continues collection', async () => {
  const f = await fixture({ state: { running: false, tabId: 7 } });
  await f.tick();
  assert.deepEqual(f.navigations, []);
  await f.send('toggle');
  assert.deepEqual(f.navigations, ['/s/123/2/']);
});

test('another tab never takes over navigation', async () => {
  const f = await fixture({ state: { running: true, tabId: 99 } });
  await f.tick();
  assert.deepEqual(f.navigations, []);
});

test('downloads once when complete and allows an explicit second download', async () => {
  const f = await fixture({ count: 1 });
  await f.tick();
  await f.tick();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.values['story:123:download'], 1);
  await f.send('download');
  assert.equal(f.downloads.length, 2);
});

test('download rejection remains visible and does not silently mark completion or loop', async () => {
  const f = await fixture({ count: 1, rejectDownload: true });
  await f.tick();
  await f.tick();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.values['story:123:download'], undefined);
  assert.match(f.document.body.textContent, /Disk full/);
  await f.send('download');
  assert.equal(f.downloads.length, 2);
});

test('clearing removes only this story and stops collection', async () => {
  const f = await fixture({ data: { 'story:999:1': { body: 'other' } } });
  await f.send('forget');
  await f.tick();
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(Object.keys(f.values), ['story:999:1']);
});

test('builds a readable EPUB and rejects an incomplete collection', async () => {
  const values = {
    'story:123:info': { title: 'A & B', author: 'Writer', count: 2 },
    'story:123:1': { heading: 'One', body: '<p>First</p>' },
    'story:123:2': { heading: 'Two', body: '<p>Second</p>' },
  };
  const context = vm.createContext({ zip, chrome: { storage: { local: { get: async (key) => ({ [key]: values[key] }) } } }, Date });
  vm.runInContext(epubSource, context);
  const { blob } = await vm.runInContext('buildStoryEpub("123")', context);
  const reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false });
  const entries = await reader.getEntries();
  assert.equal(entries[0].filename, 'mimetype');
  assert.match(await entries.find((e) => e.filename === 'chapter2.xhtml').getData(new zip.TextWriter()), /Second/);
  assert.match(await entries.find((e) => e.filename === 'content.opf').getData(new zip.TextWriter()), /A & B/);
  await reader.close();
  delete values['story:123:2'];
  await assert.rejects(vm.runInContext('buildStoryEpub("123")', context), /saved chapters changed/);
});

test('invalid chapter lists never advance or download', async () => {
  const f = await fixture({ chapter: 4, count: 3 });
  await f.tick();
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.downloads, []);
  assert.equal(f.values['story:123:4'], undefined);
  assert.match(f.document.body.textContent, /chapter list can be verified/);
});

test('background validates the calling page and propagates browser download errors', async () => {
  const source = await readFile(new URL('background.js', import.meta.url), 'utf8');
  let listener;
  let calls = 0;
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: {
        id: 'test',
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
      downloads: {
        download: async () => {
          calls++;
          throw new Error('Downloads unavailable');
        },
      },
    },
  });
  vm.runInContext(source, context);
  const sender = { id: 'test', tab: { id: 7 }, url: 'https://www.fanfiction.net/s/123/1/' };
  const invoke = (request, from = sender) =>
    new Promise((resolve) => {
      if (!listener(request, from, resolve)) resolve(undefined);
    });
  assert.equal((await invoke({ type: 'download', storyId: '123', url: 'blob:https://www.fanfiction.net/test' })).error, 'Downloads unavailable');
  let invalid;
  listener({ type: 'download', storyId: '123', url: 'https://evil.example/file' }, sender, (result) => {
    invalid = result;
  });
  assert.match(invalid.error, /could not be verified/);
  assert.equal(await invoke({ type: 'download' }, { ...sender, url: 'https://evil.example/s/123/' }), undefined);
  assert.equal(calls, 1);
});

test('a new story has a visible collection action even without a library handshake', async () => {
  const f = await fixture({ state: null });
  assert.equal(f.document.querySelector('button').textContent, 'Collect this story');
  await f.send('toggle');
  await f.tick();
  assert.deepEqual(f.navigations, ['/s/123/2/']);
});
