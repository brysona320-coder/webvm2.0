import {open, stat, mkdir, writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const IMAGE_SIZE = 629145600;
export const IMAGE_SHA256 = '0805d88eaaa300efd5b89c2a3970a2d289c07c7c6be7ad80a5da4a3451bd0045';
export const CHUNK_SIZE = 128 * 1024;

export async function splitDisk(input, output, {expectedSize = IMAGE_SIZE, expectedHash = IMAGE_SHA256} = {}) {
  const info = await stat(input);
  if (info.size !== expectedSize) throw new Error(`Debian disk size mismatch: ${info.size} bytes.`);
  const digest = createHash('sha256');
  await pipeline(createReadStream(input), digest);
  if (digest.digest('hex') !== expectedHash) throw new Error('Debian disk SHA-256 mismatch.');
  const file = await open(input, 'r');
  try {
    const magic = Buffer.alloc(2);
    await file.read(magic, 0, 2, 1080);
    if (magic.readUInt16LE() !== 0xef53) throw new Error('The downloaded disk is not an ext2 filesystem.');
    await mkdir(path.dirname(output), {recursive: true});
    for (let offset = 0, index = 0; offset < info.size; offset += CHUNK_SIZE, index++) {
      const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, info.size - offset));
      const {bytesRead} = await file.read(chunk, 0, chunk.length, offset);
      if (bytesRead !== chunk.length) throw new Error('Unexpected end of Debian image.');
      // The WebVM GitHubDevice format uses six hexadecimal digits, not decimal.
      await writeFile(`${output}.c${index.toString(16).padStart(6, '0')}.txt`, chunk);
    }
    await writeFile(`${output}.meta`, `${info.size}\n`);
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/prepare-disk.mjs <image.ext2> <output-base>');
  await splitDisk(process.argv[2], process.argv[3]);
  console.log('Verified and split the official Debian mini image for GitHub Pages.');
}
