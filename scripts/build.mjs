import {mkdir, copyFile, cp, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
for (const file of ['index.html', 'styles.css', 'app.js', 'service-worker.js', 'favicon.svg', '_headers', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
  await copyFile(path.join(root, file), path.join(out, file));
}
await cp(path.join(root, 'vendor'), path.join(out, 'vendor'), {recursive: true});
await copyFile(path.join(root, '.nojekyll'), path.join(out, '.nojekyll'));
console.log('Built BLACKWIRE static assets in dist/');
