const action = document.querySelector('#action');
const clear = document.querySelector('#forget');
const statusLabel = document.querySelector('#status');
const help = document.querySelector('#help');
async function setup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let page;
  function render(result) {
    page = result;
    statusLabel.textContent = result.error || result.message || '';
    if (result.page !== 'story') return;
    help.textContent =
      'Chapters collect automatically. Complete Cloudflare verification in the story tab when asked. The EPUB downloads when every chapter is saved.';
    clear.hidden = !result.active;
    action.hidden = false;
    action.textContent = result.complete
      ? 'Download EPUB'
      : !result.active
        ? 'Collect this story'
        : result.running
          ? 'Pause collection'
          : 'Resume collection';
  }
  async function send(method) {
    const result = await chrome.tabs.sendMessage(tab.id, method, { frameId: 0 });
    if (!result) throw new Error('Reload the story tab and try again.');
    return result;
  }
  async function handle(method) {
    action.disabled = clear.disabled = true;
    try {
      render(await send(method));
    } catch (error) {
      statusLabel.textContent = error.message;
    } finally {
      action.disabled = clear.disabled = false;
    }
  }
  render(await send('status'));
  if (page.page === 'story') {
    action.onclick = () => handle(page.complete ? 'download' : page.active ? 'toggle' : 'start');
    clear.onclick = () => handle('forget');
    setInterval(() => {
      if (!action.disabled)
        send('status')
          .then(render)
          .catch(() => {});
    }, 1500);
  } else if (page.page === 'library') {
    help.textContent = 'Open the matching book’s Story updates tab. Prepare its EPUB here, then submit the selected file in BookOrbit.';
    action.hidden = false;
    action.textContent = 'Prepare story update';
    action.onclick = () => handle('prepare');
  }
}
setup().catch(() => {
  help.textContent = 'Open a FanFiction.net chapter or BookOrbit. Reload any tab that was open when you installed the extension.';
});
