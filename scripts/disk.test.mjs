import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {splitDisk, CHUNK_SIZE} from './prepare-disk.mjs';

test('GitHubDevice chunks reconstruct the verified disk across hexadecimal boundaries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blackwire-disk-'));
  try {
    const disk = Buffer.alloc(CHUNK_SIZE * 11 + 13);
    for (let index = 0; index < disk.length; index++) disk[index] = index % 251;
    disk.writeUInt16LE(0xef53, 1080);
    const source = path.join(dir, 'input.ext2'), output = path.join(dir, 'disk.ext2');
    await writeFile(source, disk);
    const options = {expectedSize: disk.length, expectedHash: createHash('sha256').update(disk).digest('hex')};
    await splitDisk(source, output, options);
    assert.equal((await readFile(`${output}.meta`, 'utf8')).trim(), String(disk.length));
    const chunks = [];
    for (let index = 0; index < 12; index++) chunks.push(await readFile(`${output}.c${index.toString(16).padStart(6, '0')}.txt`));
    assert.deepEqual(Buffer.concat(chunks), disk);
    await assert.rejects(splitDisk(source, output, {...options, expectedHash: 'bad'}), /SHA-256/);
    await assert.rejects(splitDisk(source, output, {...options, expectedSize: 10}), /size mismatch/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
