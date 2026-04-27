'use strict';

/**
 * Terminal module tests:
 *   - Module exports all expected functions
 *   - isSpammyLog correctly filters progress bars
 *   - start/stop cycle in CI mode doesn't throw
 *   - log/warn/error don't throw
 *   - updateStats accepts various stat shapes
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const terminal = require('../src/cli/terminal');

/* ------------------------------------------------------------------ */
/* Module exports                                                      */
/* ------------------------------------------------------------------ */

test('terminal module exports all expected functions', () => {
  const expected = ['start', 'stop', 'log', 'warn', 'error', 'updateStats', 'setLiveAI', 'isSpammyLog'];
  for (const name of expected) {
    assert.equal(typeof terminal[name], 'function', `terminal.${name} should be a function`);
  }
});

/* ------------------------------------------------------------------ */
/* isSpammyLog filtering                                               */
/* ------------------------------------------------------------------ */

test('isSpammyLog identifies progress bar strings as spammy', () => {
  assert.equal(terminal.isSpammyLog('50% ▕████░░░░▏ 5/10'), true);
  assert.equal(terminal.isSpammyLog('0% ▕░░░░░░░░▏ 0/33'), true);
  assert.equal(terminal.isSpammyLog('100% ▕████████▏ 33/33'), true);
});

test('isSpammyLog allows through real log messages', () => {
  assert.equal(terminal.isSpammyLog('Using AI provider: groq (full-file mode)'), false);
  assert.equal(terminal.isSpammyLog('Loaded context files: agents.md'), false);
  assert.equal(terminal.isSpammyLog('Computing dependency map'), false);
  assert.equal(terminal.isSpammyLog('[file src/App.jsx] retry 1: rate limited'), false);
});

/* ------------------------------------------------------------------ */
/* updateStats                                                         */
/* ------------------------------------------------------------------ */

test('updateStats does not throw with various stat shapes', () => {
  assert.doesNotThrow(() => terminal.updateStats({ filesFound: 10 }));
  assert.doesNotThrow(() => terminal.updateStats({ filesAnalyzed: 5 }));
  assert.doesNotThrow(() => terminal.updateStats({ currentFile: 'src/App.jsx' }));
  assert.doesNotThrow(() => terminal.updateStats({ modelLabel: 'groq/llama3-8b-8192' }));
  assert.doesNotThrow(() => terminal.updateStats({ filesSummarizable: 8 }));
  assert.doesNotThrow(() => terminal.updateStats({}));
});

/* ------------------------------------------------------------------ */
/* log/warn/error                                                      */
/* ------------------------------------------------------------------ */

test('log/warn/error functions do not throw', () => {
  // In CI mode (no TTY), these should silently do nothing or console.log
  assert.doesNotThrow(() => terminal.log('test message'));
  assert.doesNotThrow(() => terminal.warn('test warning'));
  assert.doesNotThrow(() => terminal.error('test error'));
});

test('setLiveAI does not throw', () => {
  assert.doesNotThrow(() => terminal.setLiveAI('Processing tokens...'));
  assert.doesNotThrow(() => terminal.setLiveAI(''));
  assert.doesNotThrow(() => terminal.setLiveAI(null));
});
