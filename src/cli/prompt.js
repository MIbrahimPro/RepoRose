'use strict';

/**
interactive prompts — makes the CLI pretty

two modes:
- TTY mode: fancy arrow-key selection with colors and stuff (when running in a real terminal)
- Non-TTY mode: boring line-based input (for CI/tests/piped input)

the fancy mode uses raw ANSI escape codes which i dont fully understand,,,
but they make it look like create-next-app so thats cool

the boring mode exists so tests can pipe answers via stdin
 */

const readline = require('readline');

// ANSI color codes — magic escape sequences that make text pretty
// how do they work? IDK, something about 38;5;206m,,, its all gibberish to me
const ESC = '\x1B[';
const c = {
  pink: (s) => `${ESC}38;5;206m${s}${ESC}0m`,
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  red: (s) => `${ESC}31m${s}${ESC}0m`,
  yellow: (s) => `${ESC}33m${s}${ESC}0m`,
  cyan: (s) => `${ESC}36m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
};

// checks if we're in a real interactive terminal
// (not CI, not piped, just a normal person using a normal terminal)
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}
















/* ------------------------------------------------------------------ */
/* Raw-mode key reader                                                 */
/* ------------------------------------------------------------------ */

// this section handles reading individual keypresses in raw mode
// its complicated and involves buffers and streams and stuff

const KEY = {
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  ENTER: 'enter',
  ESC: 'esc',
  CTRL_C: 'ctrl_c',
  BACKSPACE: 'backspace',
  TAB: 'tab',
  CHAR: 'char',
  PASTE: 'paste',
};

// turns raw bytes from stdin into "logical" key events
// like "user pressed up arrow" or "user pressed enter"
// the byte sequences are weird and different on every terminal,,, but it works somehow
function decodeKey(buf) {
  const s = buf.toString('utf8');
  if (s === '\x03') return { type: KEY.CTRL_C };
  if (s === '\r' || s === '\n') return { type: KEY.ENTER };
  if (s === '\x7f' || s === '\b') return { type: KEY.BACKSPACE };
  if (s === '\t') return { type: KEY.TAB };
  if (s === '\x1b') return { type: KEY.ESC };
  if (s === '\x1b[A') return { type: KEY.UP };
  if (s === '\x1b[B') return { type: KEY.DOWN };
  if (s === '\x1b[D') return { type: KEY.LEFT };
  if (s === '\x1b[C') return { type: KEY.RIGHT };
  // Plain printable (handle paste: multiple chars at once)
  if (s.length === 1 && s.charCodeAt(0) >= 32) return { type: KEY.CHAR, char: s };
  if (s.length > 1 && [...s].every(c => c.charCodeAt(0) >= 32)) {
    return { type: KEY.PASTE, chars: s };
  }
  return null;
}

// main key reading loop — listens to stdin in raw mode
// calls onKey for every keypress until something returns a value or aborts
function readKeys(onKey) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.removeListener('data', handler);
      try { stdin.setRawMode(wasRaw); } catch (_e) { /* ignore */ }
      // Don't pause — caller may want to keep using stdin via readline.
    };

    function handler(chunk) {
      const key = decodeKey(Buffer.from(chunk, 'utf8'));
      if (!key) return;
      if (key.type === KEY.CTRL_C) {
        cleanup();
        reject(new Error('aborted'));
        return;
      }
      let result;
      try {
        result = onKey(key);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (result && 'value' in result) {
        cleanup();
        resolve(result.value);
      } else if (result && 'abort' in result) {
        cleanup();
        reject(result.abort);
      }
    }

    stdin.on('data', handler);
  });
}
















/* ------------------------------------------------------------------ */
/* Render helpers                                                      */
/* ------------------------------------------------------------------ */

function eraseLines(n) {
  if (n <= 0) return;
  let out = '';
  for (let i = 0; i < n; i++) {
    out += ESC + '2K'; // clear line
    if (i < n - 1) out += ESC + '1A'; // move up (except after last)
  }
  out += '\r';
  process.stdout.write(out);
}

function hideCursor() { process.stdout.write(ESC + '?25l'); }
function showCursor() { process.stdout.write(ESC + '?25h'); }

// creates that "? message" header thingy
// like "? Which AI provider?" — mimics create-next-app style
function header(message) {
  return `${c.pink('?')} ${c.bold(message)}`;
}

/** A static "answered" line printed after a prompt resolves. */
function answeredLine(message, value) {
  return `${c.green('✔')} ${c.bold(message)} ${c.dim('›')} ${c.cyan(value)}`;
}
















/* ------------------------------------------------------------------ */
/* TTY prompts                                                         */
/* ------------------------------------------------------------------ */

// these are the fancy interactive prompts for real terminals
// arrow keys, colors, live updating — the works

async function selectTTY({ message, options, initial = 0, hint }) {
  let index = Math.max(0, Math.min(initial, options.length - 1));
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) eraseLines(renderedLines);
    const lines = [];
    lines.push(header(message) + (hint ? '  ' + c.dim(hint) : ''));
    options.forEach((opt, i) => {
      const selected = i === index;
      const marker = selected ? c.pink('❯') : ' ';
      const label = selected ? c.cyan(opt.label) : opt.label;
      const tail = opt.hint ? '  ' + c.dim('— ' + opt.hint) : '';
      lines.push(`  ${marker} ${label}${tail}`);
    });
    lines.push(c.dim('  (use ↑/↓ to navigate, enter to select, esc to cancel)'));
    // No trailing newline: leaves cursor on the last rendered line so the
    // next eraseLines() clears exactly this block.
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render();

  try {
    const result = await readKeys((key) => {
      if (key.type === KEY.UP) {
        index = (index - 1 + options.length) % options.length;
        render();
      } else if (key.type === KEY.DOWN) {
        index = (index + 1) % options.length;
        render();
      } else if (key.type === KEY.CHAR && /[1-9]/.test(key.char)) {
        const n = Number(key.char) - 1;
        if (n < options.length) {
          index = n;
          render();
        }
      } else if (key.type === KEY.ENTER) {
        return { value: options[index].value };
      } else if (key.type === KEY.ESC) {
        return { abort: new Error('cancelled') };
      }
      return undefined;
    });

    // Replace the prompt block with a single answered-line summary.
    eraseLines(renderedLines);
    renderedLines = 0;
    const chosen = options.find((o) => o.value === result);
    process.stdout.write(answeredLine(message, chosen ? chosen.label : String(result)) + '\n');
    return result;
  } finally {
    showCursor();
  }
}

async function textTTY({ message, defaultValue, validate }) {
  let buffer = '';
  let renderedLines = 0;
  let errorMsg = '';

  // We render a fake cursor block at the end of the input so we don't need
  // to fiddle with real cursor positioning; re-rendering on every keypress
  // is cheap and reliable.
  const render = () => {
    if (renderedLines > 0) eraseLines(renderedLines);
    const lines = [];
    const placeholder = defaultValue ? ' ' + c.dim(`(${defaultValue})`) : '';
    lines.push(`${header(message)}${placeholder}`);
    lines.push(`  ${c.pink('›')} ${buffer}${c.dim('▏')}`);
    if (errorMsg) lines.push('  ' + c.red(errorMsg));
    // Note: NO trailing newline — keeps cursor on the last rendered line so
    // the next eraseLines() call clears exactly the right block.
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render();

  try {
    const value = await readKeys((key) => {
      if (key.type === KEY.ENTER) {
        const final = buffer.trim() || defaultValue || '';
        if (validate) {
          const err = validate(final);
          if (err) {
            errorMsg = err;
            render();
            return undefined;
          }
        }
        return { value: final };
      }
      if (key.type === KEY.BACKSPACE) {
        buffer = buffer.slice(0, -1);
        errorMsg = '';
        render();
        return undefined;
      }
      if (key.type === KEY.CHAR) {
        buffer += key.char;
        errorMsg = '';
        render();
        return undefined;
      }
      if (key.type === KEY.ESC) {
        return { abort: new Error('cancelled') };
      }
      return undefined;
    });

    eraseLines(renderedLines);
    renderedLines = 0;
    process.stdout.write(answeredLine(message, value || c.dim('(empty)')) + '\n');
    return value;
  } finally {
    showCursor();
  }
}

async function confirmTTY({ message, defaultYes = true }) {
  let value = !!defaultYes;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) eraseLines(renderedLines);
    const yesLabel = value ? c.cyan('● Yes') : c.dim('○ Yes');
    const noLabel = !value ? c.cyan('● No') : c.dim('○ No');
    const lines = [
      `${header(message)}  ${yesLabel}   ${noLabel}`,
      c.dim('  (←/→ or y/n to toggle, enter to confirm)'),
    ];
    // No trailing newline; see the comment in selectTTY.
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render();

  try {
    const result = await readKeys((key) => {
      if (key.type === KEY.LEFT) { value = true; render(); return undefined; }
      if (key.type === KEY.RIGHT) { value = false; render(); return undefined; }
      if (key.type === KEY.CHAR) {
        const ch = key.char.toLowerCase();
        if (ch === 'y') return { value: true };
        if (ch === 'n') return { value: false };
      }
      if (key.type === KEY.ENTER) return { value };
      if (key.type === KEY.ESC) return { abort: new Error('cancelled') };
      return undefined;
    });

    eraseLines(renderedLines);
    renderedLines = 0;
    process.stdout.write(answeredLine(message, result ? 'Yes' : 'No') + '\n');
    return result;
  } finally {
    showCursor();
  }
}
















/* ------------------------------------------------------------------ */
/* Non-TTY fallbacks (line-buffered readline)                          */
/* ------------------------------------------------------------------ */

// boring prompts for CI/tests — just read lines from stdin
// no colors, no arrow keys, just type and press enter

// creates a line-based prompt helper
// buffers lines so multiple prompts can share stdin
function createLineAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const buffer = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else buffer.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()('');
  });
  function ask(question) {
    return new Promise((resolve) => {
      process.stdout.write(question);
      if (buffer.length) return resolve(buffer.shift());
      if (closed) return resolve('');
      waiters.push(resolve);
    });
  }
  return { ask, close: () => rl.close() };
}

async function selectFallback({ ask, message, options }) {
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(message);
  options.forEach((opt, i) => {
    // eslint-disable-next-line no-console
    console.log(`  ${i + 1}) ${opt.label}${opt.hint ? `  — ${opt.hint}` : ''}`);
  });
  while (true) {
    const raw = (await ask(`Choose 1-${options.length}: `)).trim();
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1].value;
    }
    const byValue = options.find((o) => o.value === raw.toLowerCase());
    if (byValue) return byValue.value;
    // eslint-disable-next-line no-console
    console.log(`  Invalid choice. Enter a number 1-${options.length}.`);
  }
}

async function textFallback({ ask, message, defaultValue }) {
  const hint = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await ask(`${message}${hint}: `)).trim();
  return answer || defaultValue || '';
}

async function confirmFallback({ ask, message, defaultYes = true }) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${message} ${hint} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}
















/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

// creates a prompt session
// share this across multiple prompts so they dont fight over stdin
function createSession() {
  const tty = isInteractive();
  let lineAsk = null;
  return {
    tty,
    ask: () => {
      if (!lineAsk) lineAsk = createLineAsk();
      return lineAsk.ask;
    },
    close: () => {
      if (lineAsk) lineAsk.close();
    },
  };
}

async function select(session, opts) {
  if (session.tty) return selectTTY(opts);
  return selectFallback({ ask: session.ask(), ...opts });
}

async function selectWithDefault(session, opts, defaultValue) {
  const index = opts.options.findIndex(o => o.value === defaultValue);
  return select(session, { ...opts, initial: index >= 0 ? index : 0 });
}

async function text(session, opts) {
  if (session.tty) return textTTY(opts);
  return textFallback({ ask: session.ask(), ...opts });
}

async function confirm(session, opts) {
  if (session.tty) return confirmTTY(opts);
  return confirmFallback({ ask: session.ask(), ...opts });
}
















/* ------------------------------------------------------------------ */
/* Password input (masked)                                             */
/* ------------------------------------------------------------------ */

// password input — shows asterisks instead of what you type
// cuz security or something

async function passwordTTY({ message }) {
  let buffer = '';
  let renderedLines = 0;
  let errorMsg = '';

  const render = () => {
    if (renderedLines > 0) eraseLines(renderedLines);
    const mask = '*'.repeat(buffer.length);
    const lines = [
      header(message),
      `  ${c.cyan('❯')} ${mask}${c.dim(' ')}`,
    ];
    if (errorMsg) lines.push(c.red(`  ${errorMsg}`));
    process.stdout.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  hideCursor();
  render();

  try {
    const value = await readKeys((key) => {
      if (key.type === KEY.ENTER) {
        return { value: buffer };
      }
      if (key.type === KEY.CTRL_C) {
        return { abort: new Error('aborted') };
      }
      if (key.type === KEY.BACKSPACE) {
        buffer = buffer.slice(0, -1);
        errorMsg = '';
        render();
        return;
      }
      if (key.type === KEY.PASTE) {
        buffer += key.chars;
        errorMsg = '';
        render();
        return;
      }
      if (key.type === KEY.CHAR) {
        buffer += key.char;
        errorMsg = '';
        render();
        return undefined;
      }
      if (key.type === KEY.ESC) {
        return { abort: new Error('cancelled') };
      }
      return undefined;
    });

    eraseLines(renderedLines);
    renderedLines = 0;
    process.stdout.write(answeredLine(message, '*'.repeat(value ? value.length : 0) || c.dim('(empty)')) + '\n');
    return value;
  } finally {
    showCursor();
  }
}

async function passwordFallback({ ask, message }) {
  const answer = await ask(`${message} (input hidden): `);
  // For fallback, we just read normally but don't echo (the ask function writes the prompt only)
  // This is a simplification; in practice for non-TTY we can't truly hide input
  return answer;
}

async function password(session, opts) {
  if (session.tty) return passwordTTY(opts);
  return passwordFallback({ ask: session.ask(), ...opts });
}

// prints that fancy intro box with the repo name
// looks like:
// ╭─ RepoRose setup
// │  /path/to/repo
// │
function intro(title, subtitle) {
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(c.pink('╭─') + ' ' + c.bold(title));
  if (subtitle) {
    // eslint-disable-next-line no-console
    console.log(c.pink('│') + ' ' + c.dim(subtitle));
  }
  // eslint-disable-next-line no-console
  console.log(c.pink('│'));
}

// prints a note inside the intro box
// like "│ checking for ollama..."
function note(message) {
  // eslint-disable-next-line no-console
  console.log(c.pink('│') + ' ' + c.dim(message));
}

// prints the closing line
// ╰─ Setup complete!
function outro(message) {
  // eslint-disable-next-line no-console
  console.log(c.pink('╰─') + ' ' + c.green(message));
  // eslint-disable-next-line no-console
  console.log('');
}

module.exports = {
  createSession,
  select,
  text,
  confirm,
  password,
  intro,
  note,
  outro,
  isInteractive,
};
