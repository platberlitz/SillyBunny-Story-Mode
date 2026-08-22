import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('release metadata points to existing entry files', () => {
    const manifest = readJson('../manifest.json');
    const packageJson = readJson('../package.json');

    assert.equal(manifest.version, packageJson.version);
    assert.ok(Array.isArray(manifest.requires));
    assert.ok(existsSync(new URL(`../${manifest.js}`, import.meta.url)));
    assert.ok(existsSync(new URL(`../${manifest.css}`, import.meta.url)));
});
