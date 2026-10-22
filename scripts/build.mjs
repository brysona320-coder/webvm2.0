import {mkdir, copyFile, cp, rm, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
for (const file of ['index.html', 'styles.css', 'app.js', 'wisp-network.js', 'service-worker.js', 'favicon.svg', '_headers', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
  await copyFile(path.join(root, file), path.join(out, file));
}
await cp(path.join(root, 'vendor'), path.join(out, 'vendor'), {recursive: true});
await copyFile(path.join(root, '.nojekyll'), path.join(out, '.nojekyll'));
// Each deployment must load matching JS/CSS even while Pages caches old assets.
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
const networkHash = hash(await readFile(path.join(root, 'wisp-network.js')));
const app = (await readFile(path.join(root, 'app.js'), 'utf8')).replace("'./wisp-network.js'", `'./wisp-network.js?v=${networkHash}'`);
await writeFile(path.join(out, 'app.js'), app);
const styleHash = hash(await readFile(path.join(root, 'styles.css')));
const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
  .replace('./app.js"', `./app.js?v=${hash(app)}"`)
  .replace('./styles.css"', `./styles.css?v=${styleHash}"`);
await writeFile(path.join(out, 'index.html'), html);
console.log('Built BLACKWIRE static assets in dist/');
