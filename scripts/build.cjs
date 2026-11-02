// Bundles src/core.js + src/ui.js into the delivery forms (console paste, full bookmarklet,
// loader bookmarklet) plus an install page. No dependencies: plain concatenation inside one IIFE.
// There is deliberately no userscript: this is a one-time repair, not something to keep installed,
// and Risu runs on many origins (risuai.xyz, self-hosted builds, forks) that one @match cannot name.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { version } = pkg;
const REPO_URL = pkg.homepage;
// The loader bookmarklet fetches the hosted console bundle, so it follows releases on main.
const HOSTED_CONSOLE_URL = 'https://ruyari-cupcake.github.io/cupcake-risu-plugin-storage-fix/dist/console.js';
const STRIP_MARKER = '@strip-in-bundle';
// MIT asks for the notice in every copy; a block comment survives the bookmarklet's newline loss.
const NOTICE = `/*! 컵케익 리스 플러그인 저장소 고치기 v${version} | (c) 2026 Ruyari Cupcake | MIT License | ${REPO_URL} */`;

function source(file) {
  return fs.readFileSync(path.join(ROOT, 'src', file), 'utf8')
    .split('\n')
    .filter((line) => !line.includes(STRIP_MARKER))
    .join('\n')
    .replaceAll('__RPF_VERSION__', version);
}

function bundle(entryCall) {
  return `${NOTICE}\n(() => {\n${source('core.js')}\n${source('ui.js')}\n${entryCall}\n})();\n`;
}

const consoleBundle = bundle('openFixPanel();');
// Some bookmark managers flatten the URL to one line; with full-line comments gone (and no
// trailing ones in src), the body still parses when every newline is lost.
const bookmarkletBody = consoleBundle.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
const bookmarklet = `javascript:${encodeURIComponent(bookmarkletBody)}`;
// Phones choke on a long inline URL (seen with the backup-unlock tool on mobile Chrome), so the
// loader is short and has nothing a URL layer could rewrite: ASCII only, no whitespace, `%`, `+` or `#`.
const loaderBookmarklet = "javascript:void(document.head.appendChild(Object.assign(document.createElement('script'),"
  + `{src:'${HOSTED_CONSOLE_URL}',onerror:function(){alert('Cupcake-plugin-storage-fix:load-failed(network?)')}})))`;

const installPage = fs.readFileSync(path.join(ROOT, 'src', 'install.template.html'), 'utf8')
  .replaceAll('__RPF_VERSION__', version)
  .replaceAll('__RPF_REPO_URL__', REPO_URL)
  .replaceAll('__RPF_LOADER__', loaderBookmarklet)
  .replaceAll('__RPF_BOOKMARKLET__', bookmarklet)
  .replaceAll('__RPF_BOOKMARKLET_KB__', String(Math.round(bookmarklet.length / 1024)));

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'console.js'), consoleBundle);
fs.writeFileSync(path.join(DIST, 'bookmarklet.txt'), `${bookmarklet}\n`);
fs.writeFileSync(path.join(DIST, 'loader-bookmarklet.txt'), `${loaderBookmarklet}\n`);
fs.writeFileSync(path.join(DIST, 'install.html'), installPage);
console.log(`built v${version}: console ${consoleBundle.length} B, bookmarklet ${bookmarklet.length} B, loader ${loaderBookmarklet.length} B`);
