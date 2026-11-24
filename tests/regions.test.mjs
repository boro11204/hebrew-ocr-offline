import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOptions } from '../docs/core.js';
import { cropRegion, regionHeading, regionRect, regionScript } from '../docs/regions.js';

test('backward drags and drags outside the preview stay inside the page', () => {
  const expected = { left: 0, top: 0.1, right: 0.6, bottom: 1 };
  const a = { x: 0.6, y: 1.3 };
  const b = { x: -0.2, y: 0.1 };
  assert.deepEqual(regionRect(a, b), expected);
  assert.deepEqual(regionRect(b, a), expected);
});

test('crop coordinates use the source resolution and include the edge pixels', t => {
  const source = { width: 1002, height: 201 };
  const calls = [];
  const context = {
    fillRect: (...args) => calls.push([context.fillStyle, ...args]),
    drawImage: (...args) => calls.push(args)
  };
  const canvas = { getContext: () => context };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas };
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  });
  cropRegion(source, { left: 0.25, right: 0.5, top: 0.1, bottom: 0.5 });
  assert.equal(canvas.width, 271);
  assert.equal(canvas.height, 101);
  assert.deepEqual(calls, [
    ['white', 0, 0, 271, 101],
    [source, 250, 20, 251, 81, 10, 10, 251, 81]
  ]);
});

test('region types pick the script and headings survive joining printed lines', () => {
  assert.equal(regionScript({ kind: 'gemara' }, 'rashi'), 'square');
  assert.equal(regionScript({ kind: 'rashi' }, 'square'), 'rashi');
  assert.equal(regionScript({ kind: 'tosafos' }, 'square'), 'rashi');
  assert.equal(regionScript({ kind: 'auto' }, 'mixed'), 'mixed');
  const first = regionHeading({ kind: 'tosafos' }, 0);
  const second = regionHeading({ kind: 'gemara' }, 1);
  assert.equal(applyOptions(first + '\nא\nב\n\n' + second + '\nג', { lines: 'join' }),
    '[[תוספות 1]]\nא ב\n\n[[גמרא 2]]\nג');
});
