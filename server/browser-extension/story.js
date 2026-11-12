// Runs in the extension's isolated world on story pages only.
(() => {
  const match = location.pathname.match(/^\/s\/(\d+)(?:\/(\d+))?(?:\/|$)/);
  if (!match) return;
  const [, id, number = '1'] = match;
  const activeKey = 'collect:' + id;
  const storage = chrome.storage.local;
  const key = 'story:' + id + ':';
  const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const tags = new Set(['p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub', 'blockquote', 'div', 'ol', 'ul', 'li', 'h2', 'h3']);
  function markup(node) {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
    if (!(node instanceof HTMLElement) || node.hidden || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT'].includes(node.tagName)) return '';
    const name = node.localName;
    if (name === 'br' || name === 'hr') return '<' + name + '/>';
    const body = Array.from(node.childNodes, markup).join('');
    return tags.has(name) ? '<' + name + '>' + body + '</' + name + '>' : body;
  }
  async function save() {
    const story = document.querySelector('#storytext');
    const profile = document.querySelector('#profile_top');
    const title = profile?.querySelector('b.xcontrast_txt, b')?.textContent.trim();
    const author = profile?.querySelector('a[href*="/u/"]')?.textContent.trim();
    if (!story?.innerText.trim() || !title || !author) throw new Error('Finish verification and open a story chapter first.');
    const select = document.querySelector('select#chap_select');
    const count = select?.options.length || 1;
    const index = Number(number);
    const reported = profile.textContent.match(/Chapters:\s*([\d,]+)/i);
    if (
      (reported && Number(reported[1].replaceAll(',', '')) !== count) ||
      index < 1 ||
      index > count ||
      (select && select.selectedIndex !== index - 1)
    )
      throw new Error('Reload the chapter so its chapter list can be verified.');
    const body = Array.from(story.childNodes, markup).join('');
    if (!body.trim()) throw new Error('The chapter is empty.');
    await storage.set({
      [key + index]: { heading: select?.selectedOptions[0]?.textContent.trim() || title, body },
      [key + 'info']: { title, author, count },
    });
    return count;
  }
  let busy = false;
  let saved = false;
  let readyAt = 0;
  let error = '';
  let tabId;
  let panel;
  let message;
  let toggle;
  let downloadButton;
  let clearButton;
  let navigating = false;

  async function progress() {
    const data = await storage.get([activeKey, key + 'info', key + 'download', key + 'delivery']);
    const info = data[key + 'info'];
    const state = data[activeKey];
    const keys = new Set(await storage.getKeys());
    const missing = info ? Array.from({ length: info.count }, (_, i) => i + 1).filter((i) => !keys.has(key + i)) : [];
    return { state, info, missing, delivery: data[key + 'delivery'], downloaded: data[key + 'download'] === info?.count };
  }

  function mount() {
    if (panel?.isConnected) return;
    panel = document.createElement('section');
    panel.setAttribute('aria-label', 'BookOrbit chapter collection');
    panel.style.cssText =
      'position:sticky;top:0;z-index:2147483647;padding:12px;background:Canvas;color:CanvasText;border:1px solid GrayText;font:14px/1.5 system-ui';
    message = document.createElement('p');
    message.setAttribute('role', 'status');
    toggle = document.createElement('button');
    toggle.onclick = () => runAction('toggle');
    downloadButton = document.createElement('button');
    downloadButton.textContent = 'Download EPUB';
    downloadButton.onclick = () => runAction('download');
    clearButton = document.createElement('button');
    clearButton.textContent = 'Clear saved chapters';
    clearButton.onclick = () => runAction('forget');
    const link = document.createElement('a');
    link.href = 'https://books.camille.studio';
    link.textContent = 'Go to BookOrbit';
    panel.append(message, toggle, ' ', downloadButton, ' ', clearButton, ' ', link);
    document.body.prepend(panel);
  }

  function render(p) {
    mount();
    const running = p.state === true || p.state?.running;
    toggle.textContent = !p.state ? 'Collect this story' : running ? 'Pause collection' : 'Resume collection';
    clearButton.hidden = !p.state;
    toggle.disabled = busy;
    downloadButton.hidden = !p.info || p.missing.length > 0;
    downloadButton.disabled = busy;
    let text = p.info ? p.info.count - p.missing.length + ' of ' + p.info.count + ' chapters saved. ' : '';
    if (error) text += error;
    else if (!p.missing.length && p.info) text += p.downloaded ? p.delivery || 'EPUB sent to Downloads.' : 'Preparing EPUB…';
    else if (!p.state) text += '';
    else if (!running) text += 'Collection paused.';
    else if (!document.querySelector('#storytext')?.innerText.trim())
      text += 'Complete Cloudflare verification here. Collection will resume automatically.';
    else if (p.state?.tabId !== undefined && p.state.tabId !== tabId) text += 'Collecting in another tab. Resume here to use this tab.';
    else text += 'Collecting chapters automatically.';
    message.textContent = text;
    return text;
  }

  async function download() {
    const { blob, info } = await buildStoryEpub(id);
    const url = URL.createObjectURL(blob);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'download', storyId: id, url });
      if (result?.error || !Number.isInteger(result?.downloadId))
        throw new Error(result?.error || 'The download did not start. Try Download EPUB again.');
      await storage.set({ [key + 'download']: info.count, [key + 'delivery']: result.message || 'EPUB sent to Downloads.' });
    } finally {
      // Let the browser take ownership of the blob before releasing the page's URL.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  async function tick() {
    if (busy || navigating) return;
    busy = true;
    try {
      let p = await progress();
      if (!p.state) return;
      if (tabId === undefined) tabId = (await chrome.runtime.sendMessage({ type: 'identity' })).tabId;
      if (!saved && document.querySelector('#storytext')?.innerText.trim()) {
        await save();
        saved = true;
        readyAt = Date.now() + 2000;
        error = '';
        p = await progress();
      }
      render(p);
      const running = p.state === true || p.state.running;
      const owner = p.state === true || p.state.tabId === tabId;
      if (!running || !owner || !saved || Date.now() < readyAt || error) return;
      if (p.state === true) await storage.set({ [activeKey]: { running: true, tabId } });
      if (!p.missing.length) {
        if (!p.downloaded) await download();
        await storage.set({ [activeKey]: { running: false, tabId } });
      } else {
        // Navigate only after the current chapter is durably saved. Challenge pages never advance.
        navigating = true;
        location.assign('/s/' + id + '/' + p.missing[0] + '/');
      }
    } catch (e) {
      error = e.message + ' Use Resume collection or Download EPUB to retry.';
    } finally {
      busy = false;
      const p = await progress();
      render(p);
    }
  }

  async function runAction(action) {
    if (busy) return;
    busy = true;
    try {
      error = '';
      tabId ??= (await chrome.runtime.sendMessage({ type: 'identity' })).tabId;
      const p = await progress();
      if (action === 'forget') {
        await storage.remove([activeKey, ...(await storage.getKeys()).filter((name) => name.startsWith(key))]);
        saved = false;
        panel?.remove();
      } else if (action === 'download') {
        await download();
      } else {
        const running = action === 'start' || !(p.state === true || (p.state?.running && p.state.tabId === tabId));
        await storage.set({ [activeKey]: { running, tabId } });
      }
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
    await tick();
    const p = await progress();
    return {
      page: 'story',
      active: !!p.state,
      running: p.state === true || !!p.state?.running,
      complete: !!p.info && !p.missing.length,
      message: p.state ? render(p) : '',
      error,
    };
  }

  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !['status', 'start', 'toggle', 'download', 'forget'].includes(request)) return;
    const act =
      request === 'status'
        ? tick().then(async () => {
            const p = await progress();
            return {
              page: 'story',
              active: !!p.state,
              running: p.state === true || !!p.state?.running,
              complete: !!p.info && !p.missing.length,
              message: p.state ? render(p) : '',
              error,
            };
          })
        : runAction(request);
    act.then(respond, (e) => respond({ page: 'story', error: e.message }));
    return true;
  });
  setInterval(() => void tick(), 2000);
  void tick();
})();
