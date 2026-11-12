"""Build the BookOrbit macOS wrapper with its site-specific chapter collector."""
from pathlib import Path
import shutil, subprocess, sys, tempfile
repo = Path(__file__).resolve().parents[2]
if len(sys.argv) > 1:
    repo = Path(sys.argv[1]).resolve()
extension = repo / 'server/browser-extension'
with tempfile.TemporaryDirectory() as tmp:
    js = Path(tmp) / 'bookorbit.js'
    code = (extension/'desktop.js').read_text()
    for marker, path in {
        '/* STORY */': extension/'story.js',
        '/* STORY_ZIP */': repo/'server/node_modules/@zip.js/zip.js/dist/zip-native.min.js',
        '/* STORY_EPUB */': extension/'epub.js',
        '/* EPUB */': extension/'epub.js',
        '/* PREPARE */': extension/'prepare.js',
        '/* ZIP */': repo/'server/node_modules/@zip.js/zip.js/dist/zip-native.min.js'
    }.items():
        assert code.count(marker) == 1
        code = code.replace(marker,path.read_text())
    js.write_text(code)
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(code)
    else:
        subprocess.run(['pake','https://books.camille.studio','--name','BookOrbit','--identifier','studio.camille.pake.bookorbit','--app-version','1.0.3','--icon',str(repo/'client/public/pwa-512x512.png'),'--new-window','--enable-find','--width','1280','--height','860','--no-restore-last-url','--internal-url-regex',r'^https://(?:books\.camille\.studio|(?:www\.)?fanfiction\.net)(?:/|$)','--inject',str(js),'--iterative-build'],check=True)

        resources = Path('BookOrbit.app/Contents/Resources')
        shutil.copyfile(repo/'server/node_modules/@zip.js/zip.js/LICENSE',resources/'zip-LICENSE.txt')
        subprocess.run(['codesign','--force','--sign','-','BookOrbit.app'],check=True)
        subprocess.run(['codesign','--verify','--deep','--strict','BookOrbit.app'],check=True)
