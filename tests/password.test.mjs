import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const module = { exports: {} };
runInNewContext(
  transformSync(readFileSync(new URL('../src/password.ts', import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code,
  {
    module,
    exports: module.exports,
    crypto: globalThis.crypto,
    btoa,
    atob,
    TextEncoder,
  },
);

const { createSalt, hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } = module.exports;

test('password hashes are salted, verifiable, and never stored in plaintext', async () => {
  const salt = createSalt();
  const hash = await hashPassword('correct horse', salt);

  assert.notEqual(hash, 'correct horse');
  assert.equal(await verifyPassword('correct horse', hash, salt), true);
  assert.equal(await verifyPassword('wrong password', hash, salt), false);
  assert.equal(await verifyPassword('correct horse', hash, createSalt()), false);
  assert.equal(MIN_PASSWORD_LENGTH, 4);
});
