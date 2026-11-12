(() => {
  if (window !== window.top) return;
  const library = location.origin === 'https://books.camille.studio';
  const story = /^https:\/\/(?:www\.|m\.)?fanfiction\.net\/s\/(\d+)(?:\/|$)/.exec(location.href);
  if (!library && !story) return;
  const begin = async () => {
    let receive;
    const runtime = {
      id: 'bookorbit',
      onMessage: {
        addListener(fn) {
          receive = fn;
        },
      },
    };
    const send = (request) =>
      new Promise((resolve, reject) =>
        receive(request, { id: runtime.id }, (result) => (result.error ? reject(new Error(result.error)) : resolve(result))),
      );
    const chrome = { runtime, storage: {} };
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    if (story) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('bookorbit-chapters', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('chapters');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      function transact(mode, fn) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction('chapters', mode);
          const result = fn(tx.objectStore('chapters'));
          tx.oncomplete = () => resolve(result?.result);
          tx.onabort = () => reject(tx.error || new Error('Could not save chapters.'));
        });
      }
      const storage = {
        async get(keys) {
          const result = {};
          await transact('readonly', (store) => {
            for (const k of [].concat(keys)) {
              const req = store.get(k);
              req.onsuccess = () => {
                result[k] = req.result;
              };
            }
          });
          return result;
        },
        getKeys: () => transact('readonly', (s) => s.getAllKeys()),
        set: (values) =>
          transact('readwrite', (s) => {
            for (const [k, v] of Object.entries(values)) s.put(v, k);
          }),
        remove: (keys) =>
          transact('readwrite', (s) => {
            for (const k of keys) s.delete(k);
          }),
      };
      chrome.storage.local = storage;
      const zip = (() => {
        const module = { exports: {} },
          exports = module.exports;
        /* STORY_ZIP */
        return module.exports;
      })();
      /* STORY_EPUB */
      const id = story[1],
        key = 'story:' + id + ':';
      let libraryWindow;
      let pending;
      const tabKey = 'bookorbit-collector-tab';
      let tabId = Number(sessionStorage.getItem(tabKey));
      if (!tabId) {
        tabId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
        sessionStorage.setItem(tabKey, String(tabId));
      }
      window.addEventListener('message', async (event) => {
        if (event.origin !== 'https://books.camille.studio' || !event.source || event.data?.id !== id) return;
        if (event.data.type === 'bookorbit:collection-result' && event.source === libraryWindow && pending && event.data.requestId === pending.id) {
          if (event.data.error) pending.reject(new Error(event.data.error));
          else pending.resolve({ downloadId: 0, message: 'Update submitted in BookOrbit.' });
          pending = undefined;
          return;
        }
        if (event.data.type !== 'bookorbit:collect') return;
        libraryWindow = event.source;
        try {
          const status = await send('status');
          if (!status.active) await send('start');
        } catch (error) {
          console.error(error);
        }
      });
      runtime.sendMessage = async (request) => {
        if (request.type === 'identity') return { tabId };
        if (request.type !== 'download') throw new Error('Unknown collector action.');
        if (libraryWindow && !libraryWindow.closed) {
          const info = (await storage.get(key + 'info'))[key + 'info'];
          const chapters = [];
          for (let i = 1; i <= info.count; i++) {
            const chapter = (await storage.get(key + i))[key + i];
            if (!chapter) throw new Error('Chapter ' + i + ' is missing. Resume collection.');
            chapters.push(chapter);
          }
          const file = new Blob([JSON.stringify({ version: 1, id, info, chapters })], { type: 'application/octet-stream' });
          if (file.size > 128 * 1024 * 1024) throw new Error('The collection exceeds 128 MiB.');
          return new Promise((resolve, reject) => {
            const requestId = Date.now() + ':' + Math.random();
            const timer = setTimeout(() => {
              pending = undefined;
              reject(new Error('BookOrbit did not confirm the update. Open Story updates and retry Download EPUB.'));
            }, 20000);
            pending = {
              id: requestId,
              resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            };
            libraryWindow.postMessage({ type: 'bookorbit:collection', id, requestId, file }, 'https://books.camille.studio');
          });
        }
        const link = document.createElement('a');
        link.href = request.url;
        link.download = 'fanfiction-' + id + '.epub';
        document.body.append(link);
        link.click();
        link.remove();
        return { downloadId: 0, message: 'EPUB sent to Downloads. Choose it in BookOrbit’s Story updates tab.' };
      };
      /* STORY */
    } else {
      if (location.hash === '#bookorbit-return') {
        const last = sessionStorage.getItem('bookorbit-pake-last-book');
        if (/^\/book\/\d+$/.test(last || '')) {
          location.replace(last + '?tab=story-updates');
          return;
        }
      }
      // These links belong to the remote library UI. Mark them before Pake
      // decides whether to navigate this window or create a separate webview.
      function setStoryWindow(link) {
        if (!link || !/^https:\/\/(?:www\.|m\.)?fanfiction\.net\/(?:s\/\d+(?:\/|$)|login\.php(?:$|[?#]))/.test(link.href)) return;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      window.addEventListener(
        'click',
        (event) => {
          const link = event.target.closest?.('a[href]');
          if (!link || !/^https:\/\/(?:www\.|m\.)?fanfiction\.net\/(?:s\/\d+(?:\/|$)|login\.php(?:$|[?#]))/.test(link.href)) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          let note = link.parentElement.querySelector('[data-pake-window-status]');
          if (!note) {
            note = document.createElement('p');
            note.dataset.pakeWindowStatus = '';
            note.setAttribute('role', 'status');
            link.after(note);
          }
          // Create the native window during the click and disconnect its opener
          // before loading any third-party content.
          const popup = window.open('about:blank', '_blank', 'popup=yes,width=1000,height=780');
          if (!popup || popup === window || popup.closed) {
            note.textContent = 'The story window could not open. Try opening it again.';
            return;
          }
          popup.opener = null;
          const match = new URL(link.href).pathname.match(/^\/s\/(\d+)(?:\/|$)/);
          const target = document.querySelector('input[data-bookorbit-story]');
          if (match && target && storyId(target.dataset.bookorbitStory) === match[1] && !target.disabled) {
            const origin = new URL(link.href).origin;
            const requestedId = match[1];
            const stop = () => {
              clearInterval(poll);
              window.removeEventListener('message', accept);
            };
            let importing = false;
            const accept = async (event) => {
              if (
                event.origin !== origin ||
                event.source !== popup ||
                event.data?.type !== 'bookorbit:collection' ||
                event.data.id !== requestedId ||
                !(event.data.file instanceof Blob)
              )
                return;
              if (importing) return;
              importing = true;
              try {
                if (!target.isConnected || target.disabled || storyId(target.dataset.bookorbitStory) !== requestedId)
                  throw new Error('Open the matching book’s Story updates to finish.');
                await importCollection(target, event.data.file);
                popup.postMessage({ type: 'bookorbit:collection-result', id: requestedId, requestId: event.data.requestId }, origin);
                stop();
                note.textContent = 'Update submitted. Check Story updates for its progress.';
              } catch (error) {
                note.textContent = error.message;
                popup.postMessage(
                  { type: 'bookorbit:collection-result', id: requestedId, requestId: event.data.requestId, error: error.message },
                  origin,
                );
              } finally {
                importing = false;
              }
            };
            window.addEventListener('message', accept);
            const poll = setInterval(() => {
              if (popup.closed || !target.isConnected) {
                stop();
                return;
              }
              popup.postMessage({ type: 'bookorbit:collect', id: requestedId }, origin);
            }, 800);
          }
          popup.location.replace(link.href);
          note.textContent = 'Opening a separate window…';
          const started = Date.now();
          const timer = setInterval(() => {
            if (popup.closed) {
              note.textContent = 'Window closed.';
            } else {
              try {
                void popup.location.href;
                if (Date.now() - started < 30000) return;
                note.textContent = 'The new window is taking longer to load.';
              } catch {
                note.textContent = 'FanFiction.net opened in a separate window.';
              }
            }
            clearInterval(timer);
          }, 300);
        },
        true,
      );
      function describeBlockedDownload() {
        const link = document.querySelector('dialog[open] a[href]');
        if (!link || !/^https:\/\/(?:www\.|m\.)?fanfiction\.net\/s\/\d+/.test(link.href)) return;
        setStoryWindow(link);
        const dialog = link.closest('dialog');
        if (dialog.querySelector('[data-pake-download-help]')) return;
        const help = document.createElement('p');
        help.dataset.pakeDownloadHelp = '';
        help.textContent =
          'If the chapter opens directly, use Collect this story in the story window. Chapters collect automatically. Complete Cloudflare verification when asked; collection then resumes.';
        dialog.append(help);
      }
      new MutationObserver(describeBlockedDownload).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['open', 'href'],
      });
      describeBlockedDownload();
      let values = new Map();
      chrome.storage.local = {
        get: async (k) => ({ [k]: values.get(k) }),
        getKeys: async () => Array.from(values.keys()),
      };
      const zip = (() => {
        const module = { exports: {} },
          exports = module.exports;
        /* ZIP */
        return module.exports;
      })();
      /* EPUB */
      /* PREPARE */
      const storyId = (url) => /^https:\/\/(?:www\.|m\.)?fanfiction\.net\/s\/(\d+)(?:\/|$)/.exec(url || '')?.[1];
      async function importCollection(input, f) {
        input.value = '';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          if (f.size > 128 * 1024 * 1024) throw new Error('This file exceeds 128 MiB.');
          const data = JSON.parse(await f.text()),
            id = input.dataset.bookorbitStory.match(/\/s\/(\d+)(?:\/|$)/)?.[1];
          if (
            data.version !== 1 ||
            !id ||
            data.id !== id ||
            typeof data.info?.title !== 'string' ||
            typeof data.info.author !== 'string' ||
            !Array.isArray(data.chapters) ||
            !data.chapters.length ||
            data.info.count !== data.chapters.length ||
            data.info.count > 9995
          )
            throw new Error('Choose a complete collection for this story.');
          const key = 'story:' + id + ':';
          values = new Map([[key + 'info', data.info]]);
          for (const [index, ch] of data.chapters.entries()) {
            if (typeof ch.heading !== 'string' || typeof ch.body !== 'string') throw new Error('Invalid chapter.');
            // Accept only the attribute-free XHTML elements emitted by the collector.
            const tree = new DOMParser().parseFromString('<body>' + ch.body + '</body>', 'application/xml');
            if (
              tree.doctype ||
              tree.getElementsByTagName('parsererror').length ||
              [...tree.getElementsByTagName('*')].some(
                (el) => el.attributes.length || !/^(body|p|br|hr|strong|b|em|i|u|s|sup|sub|blockquote|div|ol|ul|li|h2|h3)$/.test(el.tagName),
              ) ||
              /<\?|<!/.test(ch.body)
            )
              throw new Error('Invalid chapter markup.');
            values.set(key + (index + 1), ch);
          }
          message.textContent = await prepareStoryUpdate();
          const deadline = Date.now() + 10000;
          while (input.isConnected && !input.disabled && input.form?.querySelector('button[type="submit"]')?.disabled && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          const submit = input.form?.querySelector('button[type="submit"]');
          if (!input.isConnected || input.disabled || !submit || submit.disabled)
            throw new Error('Open the matching book’s Story updates to finish.');
          input.form.requestSubmit(submit);
        } finally {
          values.clear();
        }
      }
      const install = () => {
        const input = document.querySelector('input[type=file][data-bookorbit-story]');
        if (
          !input ||
          !/^https?:\/\/(www\.)?fanfiction\.net\/s\/\d+/.test(input.dataset.bookorbitStory) ||
          input.parentNode.querySelector('[data-collected-file]')
        )
          return;
        const box = document.createElement('div');
        box.dataset.collectedFile = '';
        const label = document.createElement('label');
        label.textContent = 'Update from a saved .bookorbit file';
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.bookorbit';
        picker.onchange = async () => {
          try {
            const f = picker.files[0];
            if (!f) return;
            await importCollection(input, f);
          } catch (error) {
            message.textContent = error.message;
          } finally {
            values.clear();
            picker.value = '';
          }
        };
        label.append(picker);
        const open = document.createElement('a');
        open.textContent = 'Collect and update this book';
        open.dataset.pakeCollect = 'true';
        open.href = input.dataset.bookorbitStory;
        open.className = 'text-primary underline';
        open.onclick = () => sessionStorage.setItem('bookorbit-pake-last-book', location.pathname);
        const backup = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Use an exported collection';
        backup.append(summary, label);
        box.append(open, backup, message);
        input.closest('label').before(box);
        input.parentNode.dataset.pakeCollector = 'true';
      };
      const update = () => {
        const input = document.querySelector('input[data-bookorbit-story]');
        if (!input) return;
        const mounted = input.closest('form')?.querySelector('[data-collected-file]');
        if (mounted && mounted.querySelector('a')?.getAttribute('href') !== input.dataset.bookorbitStory) {
          mounted.remove();
          delete input.parentNode.dataset.pakeCollector;
        }
        if (!input.parentNode.dataset.pakeCollector) install();
      };
      new MutationObserver(update).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-bookorbit-story'],
      });
      update();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => begin().catch(console.error), { once: true });
  else begin().catch(console.error);
})();
