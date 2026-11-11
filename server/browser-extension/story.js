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
  async function start() {
    const count = await save();
    await storage.set({ [activeKey]: true });
    return count;
  }
  async function status() {
    const data = await storage.get([activeKey, key + 'info']);
    if (!data[activeKey]) return '';
    await save();
    const { count } = (await storage.get(key + 'info'))[key + 'info'];
    const keys = Array.from({ length: count }, (_, i) => key + (i + 1));
    // Count stored chapters without loading story text into the popup.
    const savedKeys = new Set(await storage.getKeys());
    const saved = keys.filter((key) => savedKeys.has(key)).length;
    return saved + ' of ' + count + ' chapters saved.';
  }
  async function forget() {
    await storage.remove([activeKey, ...(await storage.getKeys()).filter((name) => name.startsWith(key))]);
  }
  storage
    .get(activeKey)
    .then((data) => data[activeKey] && save())
    .catch(() => {});
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !['status', 'start', 'forget'].includes(request)) return;
    const act = async () => {
      if (request === 'start') await start();
      if (request === 'forget') await forget();
      return { page: 'story', message: await status() };
    };
    act().then(respond, (error) => respond({ page: 'story', error: error.message }));
    return true;
  });
})();
