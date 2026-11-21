import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  parseEighths, formatEighths, stepEighths,
  parsePriceCents, formatPriceInput, parseWhole,
} from './common.js';

test('measurements preserve exact eighth-inch values', () => {
  assert.equal(parseEighths('12 3/8'), 99);
  assert.equal(parseEighths('12.375'), 99);
  assert.equal(parseEighths('1/8'), 1);
  assert.equal(parseEighths('12 1/2 in'), 100);
  assert.equal(formatEighths(99), '12 3/8 in');
  assert.equal(formatEighths(100), '12 1/2 in');
  assert.equal(stepEighths(99, 1), 100);
  assert.equal(stepEighths(null, 1), 1);
  assert.equal(stepEighths(null, -1), null);
  assert.equal(stepEighths(1, -1), 1);
  assert.equal(parseEighths(''), null);
  assert.throws(() => parseEighths('12.3'), /one-eighth-inch/);
  assert.throws(() => parseEighths('0'), /positive/);
});

test('money is integer cents and blank stays null', () => {
  assert.equal(parsePriceCents('12.34'), 1234);
  assert.equal(parsePriceCents('0'), 0);
  assert.equal(parsePriceCents(''), null);
  assert.equal(formatPriceInput(1234), '12.34');
  assert.throws(() => parsePriceCents('12.345'), /two decimal/);
  assert.throws(() => parsePriceCents('-1'), /two decimal/);
});

test('intentional zero quantity remains distinct from blank', () => {
  assert.equal(parseWhole('0'), 0);
  assert.equal(parseWhole(''), null);
  assert.throws(() => parseWhole('-1'), /whole number/);
});

test('admin shell exposes required workspace controls without inline code', () => {
  const html = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  for (const text of ['Artwork', 'Add Artwork', 'Save All Draft Changes', 'Save Store Order', 'Settings', 'Orders', 'Forgot password']) assert.match(html, new RegExp(text));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /Publish All/i);
});

test('the first catalog load reaches the server instead of caching an empty page', () => {
  const javascript = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
  const loadFunction = /async function loadArtworks[\s\S]*?const key = viewKey\(\);/.exec(javascript)?.[0] || '';
  assert.ok(loadFunction);
  assert.doesNotMatch(loadFunction, /cacheCurrent\(\)/);
});

