chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !/^https:\/\/(?:www\.|m\.)?fanfiction\.net\/s\/\d+(?:\/|$)/.test(sender.url ?? '')) return;
  if (request?.type === 'identity') {
    respond({ tabId: sender.tab.id });
    return;
  }
  if (request?.type !== 'download') return;
  const origin = new URL(sender.url).origin;
  if (!request.url?.startsWith('blob:' + origin + '/') || !/^\d+$/.test(request.storyId)) {
    respond({ error: 'The EPUB download could not be verified. Reload this chapter and try again.' });
    return;
  }
  chrome.downloads.download({ url: request.url, filename: 'fanfiction-' + request.storyId + '.epub', conflictAction: 'uniquify' }).then(
    (downloadId) => respond({ downloadId }),
    (error) => respond({ error: error.message }),
  );
  return true;
});
