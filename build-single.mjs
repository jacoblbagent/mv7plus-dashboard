// Builds a single-file version of the dashboard so it can be copied to a
// Windows machine as one attachment. The split version stays the source of
// truth; this only inlines the core script.
//
// Run: node build-single.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'mv7-core.js'), 'utf8');

const tag = '<script src="mv7-core.js"></script>';
if (!html.includes(tag)) throw new Error('core script tag not found in index.html');

// A literal </script> inside the inlined code would end the tag early.
const safeCore = core.replace(/<\/script>/gi, '<\\/script>');
const out = html.replace(tag, '<script>\n' + safeCore + '\n</script>');

const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const target = path.join(dist, 'MV7Plus-Control.html');
fs.writeFileSync(target, out);
console.log(target + '  ' + out.length + ' bytes');
