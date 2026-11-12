async function prepareStoryUpdate() {
  if (location.origin !== 'https://books.camille.studio') throw new Error('Open this story in BookOrbit.');
  const input = document.querySelector('input[type=file][data-bookorbit-story]');
  if (!input || input.disabled) throw new Error('Open the existing book’s Story updates tab and wait for its replacement form.');
  const source = input.dataset.bookorbitStory;
  const match = source.match(/^https?:\/\/(?:www\.)?fanfiction\.net\/s\/(\d+)(?:\/|$)/i);
  if (!match) throw new Error('Choose a FanFiction.net story in BookOrbit.');
  const id = match[1];
  const key = 'story:' + id + ':';
  const storage = chrome.storage.local;
  const info = (await storage.get(key + 'info'))[key + 'info'];
  if (!info) throw new Error('Collect this story on FanFiction.net first.');
  const keys = new Set(await storage.getKeys());
  const chapters = Array.from({ length: info.count }, (_, i) => i + 1);
  const missing = chapters.filter((i) => !keys.has(key + i));
  if (missing.length)
    throw new Error('Open the remaining ' + missing.length + ' chapters on FanFiction.net, starting with chapter ' + missing[0] + '.');
  const { blob } = await buildStoryEpub(id);
  if (!input.isConnected || input.disabled || input.dataset.bookorbitStory !== source)
    throw new Error('The selected book changed. Open the matching story again.');
  const files = new DataTransfer();
  files.items.add(new File([blob], 'fanfiction-' + id + '.epub', { type: 'application/epub+zip' }));
  input.files = files.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const details = input.closest('details');
  if (details) details.open = true;
  input.scrollIntoView({ block: 'center' });
  return 'Prepared ' + info.count + ' chapters for ' + info.title + '. Submit the selected EPUB in BookOrbit.';
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (request === 'status') {
    respond({ page: 'library' });
    return;
  }
  if (request !== 'prepare') return;
  prepareStoryUpdate().then(
    (message) => respond({ message }),
    (error) => respond({ error: error.message }),
  );
  return true;
});
