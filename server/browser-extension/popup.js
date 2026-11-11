const action = document.querySelector('#action');
const clear = document.querySelector('#forget');
const status = document.querySelector('#status');
const help = document.querySelector('#help');
async function setup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  async function send(method) {
    const result = await chrome.tabs.sendMessage(tab.id, method, { frameId: 0 });
    if (result.error) throw new Error(result.error);
    return result;
  }
  async function handle(method) {
    action.disabled = clear.disabled = true;
    try {
      const result = await send(method);
      status.textContent = result.message;
      if (result.page === 'story') {
        clear.hidden = !result.message;
        action.hidden = !!result.message;
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      action.disabled = clear.disabled = false;
    }
  }
  const page = await chrome.tabs.sendMessage(tab.id, 'status', { frameId: 0 });
  if (page.page === 'story') {
    help.textContent = 'Start collecting this story, then open each chapter. When all chapters are saved, open its Story updates tab in BookOrbit.';
    action.textContent = 'Collect this story';
    action.hidden = !!page.message;
    clear.hidden = !page.message;
    status.textContent = page.error || page.message || '';
    action.onclick = () => handle('start');
    clear.onclick = () => handle('forget');
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
