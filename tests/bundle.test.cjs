// Checks the built delivery forms in dist/ (run `npm run build` first).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');
const read = (file) => fs.readFileSync(path.join(DIST, file), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('bookmarklet is a javascript: URL that survives losing every newline', () => {
  const url = read('bookmarklet.txt').trim();
  assert.ok(url.startsWith('javascript:'));
  const body = decodeURIComponent(url.slice('javascript:'.length));
  assert.ok(!/^\s*\/\//m.test(body), 'no full-line comments may remain');
  assert.ok(!body.includes('module.exports'), 'node export line must be stripped');
  // Compile only (never executed): flattened to one line it must still parse, whether a bookmark
  // manager turns newlines into spaces or drops them entirely.
  assert.doesNotThrow(() => new Function(body.replace(/\n/g, ' ')));
  assert.doesNotThrow(() => new Function(body.replace(/\n/g, '')));
});

test('loader bookmarklet is short and has nothing a URL layer could rewrite', () => {
  const loader = read('loader-bookmarklet.txt').trim();
  assert.ok(loader.startsWith('javascript:'));
  assert.ok(loader.length < 300, `loader is ${loader.length} chars`);
  assert.match(loader, /^[\x21-\x7e]+$/, 'printable ASCII only, no whitespace');
  assert.ok(!/[%+#]/.test(loader), 'no % (decoding), + (form decoding) or # (fragment)');
  const body = loader.slice('javascript:'.length);
  assert.equal(decodeURIComponent(body), body, 'a second URL decode changes nothing');
  assert.doesNotThrow(() => new Function(body));
  const src = /src:'([^']+)'/.exec(body)[1];
  assert.equal(src, 'https://ruyari-cupcake.github.io/cupcake-risu-plugin-storage-fix/dist/console.js');
  assert.ok(fs.existsSync(path.join(DIST, 'console.js')));
  assert.ok(read('install.html').includes(`<textarea id="code" readonly>${loader}</textarea>`), 'install page offers the loader');
});

test('every form carries the package version and no unreplaced placeholders', () => {
  for (const file of ['console.js', 'install.html']) {
    const text = read(file);
    assert.ok(!/__RPF_[A-Z_]+__/.test(text), `${file} has a placeholder left`);
    assert.ok(text.includes(version), `${file} lacks v${version}`);
  }
  const bookmarklet = read('bookmarklet.txt').trim();
  assert.ok(read('install.html').includes(`href="${bookmarklet}"`), 'install page button carries the same bookmarklet');
});

test('the console bundle opens the panel and exposes nothing globally', () => {
  const text = read('console.js');
  assert.ok(text.trimEnd().endsWith('openFixPanel();\n})();'), 'bundle ends by opening the panel inside its IIFE');
  assert.ok(text.includes('const RisuPluginStorageFix'), 'core is inside the bundle');
});
