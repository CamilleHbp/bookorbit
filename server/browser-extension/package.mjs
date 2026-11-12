import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';
const require = createRequire(import.meta.url);
const library = dirname(require.resolve('@zip.js/zip.js/package.json'));
const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
async function add(name, path) {
  await zip.add(name, new Uint8ArrayReader(await readFile(path)), { lastModDate: new Date('2020-01-01T00:00:00Z') });
}
for (const name of ['manifest.json', 'background.js', 'epub.js', 'story.js', 'popup.html', 'popup.js', 'prepare.js'])
  await add(name, new URL(name, import.meta.url));
await add('zip-native.min.js', join(library, 'dist', 'zip-native.min.js'));
await add('zip-LICENSE.txt', join(library, 'LICENSE'));
await writeFile(process.argv[2], await zip.close());
