// End to end on Android: the real phone page in Chromium (the engine of
// Chrome on Android) emulating a Pixel 7, against the real server and a
// dry-run Mac. Typing goes through the DevTools IME commands, so words arrive
// the way Gboard sends them: composed letter by letter, then committed.
//
// Needs Playwright; skipped if it isn't installed (npm i -D playwright).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { createRackpadServer, platformOf } from '../server/server.js';
import { DryRunBackend } from '../server/backend.js';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    try {
      return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
    } catch {
      return null;
    }
  }
}

const pw = loadPlaywright();
const TOKEN = 'android-token-abcdefghij';
let backend, server, port, browser, ctx, page, cdp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opsOf = (kind) => backend.ops.filter((o) => o.op === kind);
const reset = () => (backend.ops.length = 0);

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${fn}`);
}

async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

async function gesture(frames, stepMs = 16) {
  await touch('touchStart', frames[0]);
  for (const f of frames.slice(1)) {
    await sleep(stepMs);
    await touch('touchMove', f);
  }
  await touch('touchEnd', []);
}

async function settle() {
  let seen = -1;
  while (seen !== backend.ops.length) {
    seen = backend.ops.length;
    await sleep(150);
  }
}

async function center(sel) {
  const b = await page.locator(sel).boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
}

async function show(view) {
  await page.evaluate((v) => window.rackpad.showView(v), view);
  await sleep(50);
}

// What the Mac's text field would hold after the ops so far.
function macText() {
  let mac = '';
  for (const o of backend.ops) {
    if (o.op === 'text') mac += o.s;
    if (o.op === 'key' && o.code === 51) mac = mac.slice(0, -(o.n ?? 1));
  }
  return mac;
}

// Gboard types a word as a growing composition, then commits it.
async function gboardWord(word, committed = `${word} `) {
  for (let i = 1; i <= word.length; i++) {
    const text = word.slice(0, i);
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send('Input.insertText', { text: committed });
}

before(async () => {
  if (!pw) return;
  backend = new DryRunBackend();
  server = createRackpadServer({
    backend,
    token: TOKEN,
    macName: 'Test Mac',
    version: '0.0.0-test',
    pairing: { primary: `http://test-mac.local:8421/?k=${TOKEN}`, fallbacks: [`http://192.168.1.20:8421/?k=${TOKEN}`] },
  });
  port = await server.listen(0, '127.0.0.1');
  browser = await pw.chromium.launch();
  ctx = await browser.newContext({ ...pw.devices['Pixel 7'] });
  page = await ctx.newPage();
  cdp = await ctx.newCDPSession(page);
  await page.goto(`http://127.0.0.1:${port}/?k=${TOKEN}`);
  await page.waitForFunction(() => document.querySelector('#presence').dataset.state === 'open');
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const skip = !pw && 'Playwright not installed';

test('Android: connects over WebRTC and the Mac knows it is an Android phone', { skip }, async () => {
  assert.equal(await page.textContent('#mac-name'), 'Test Mac');
  assert.equal(await page.evaluate(() => window.rackpad.conn.pc?.connectionState), 'connected');
  assert.deepEqual([...server.clients.values()].map((c) => c.name), ['Android phone']);
});

test('Android: the first visit explains Add to Home screen, the Chrome way', { skip }, async () => {
  await page.waitForSelector('#install:not([hidden])');
  assert.equal(await page.isVisible('#install [data-os="android"]'), true);
  assert.equal(await page.isVisible('#install [data-os="ios"]'), false);
  assert.match(await page.textContent('#install [data-os="android"]'), /Add to Home screen/);
  await page.locator('#install-done').click();
  await page.waitForSelector('#install', { state: 'hidden' });
});

test('Android: tap clicks and one finger moves the pointer', { skip }, async () => {
  await show('pad');
  await settle();
  reset();
  const [x, y] = await center('#pad');
  await gesture([[[x, y]]]);
  await waitFor(() => opsOf('button').length === 2);
  await sleep(400); // right after a tap, touch-and-move would be a drag
  reset();
  await gesture(Array.from({ length: 10 }, (_, i) => [[x - 60 + i * 12, y]]));
  await waitFor(() => opsOf('move').reduce((s, o) => s + o.dx, 0) > 108);
  assert.equal(opsOf('button').length, 0);
});

test('Android: the first touch takes the page full screen, and the setting turns it off', { skip }, async () => {
  assert.equal(await page.isVisible('#fullscreen-row'), false, 'the row lives in Settings');
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true, 'already full screen from the earlier taps');
  await page.evaluate(() => document.querySelector('#open-settings').click());
  await page.waitForSelector('#fullscreen-row', { state: 'visible' });
  await page.locator('#s-fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.evaluate(() => document.querySelector('#settings-done').click());
  await page.evaluate(() => document.querySelector('#s-fullscreen').click()); // back on for the rest
});

test('Android: live typing mirrors each letter while Gboard is still composing the word', { skip }, async () => {
  await show('keys');
  const field = page.locator('#type-field');
  await field.focus();
  reset();
  for (const w of ['h', 'he', 'hel']) await cdp.send('Input.imeSetComposition', { text: w, selectionStart: w.length, selectionEnd: w.length });
  await waitFor(() => macText() === 'hel');
  await cdp.send('Input.imeSetComposition', { text: 'hell', selectionStart: 4, selectionEnd: 4 });
  await cdp.send('Input.imeSetComposition', { text: 'helo', selectionStart: 4, selectionEnd: 4 }); // a slip, fixed in place
  await cdp.send('Input.insertText', { text: 'hello ' }); // Gboard's correction at the space
  await gboardWord('world');
  await waitFor(() => macText() === 'hello world ');
  assert.equal(await field.inputValue(), 'hello world ');
});

test('Android: Return and Backspace work from keyboards that send no key codes', { skip }, async () => {
  reset();
  const beforeInput = (inputType) => page.locator('#type-field').evaluate((el, type) => {
    const e = new InputEvent('beforeinput', { inputType: type, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, inputType);
  assert.equal(await beforeInput('insertLineBreak'), true);
  await waitFor(() => opsOf('key').some((o) => o.code === 36));
  assert.equal(await page.locator('#type-field').inputValue(), '', 'the field starts fresh after Return');
  reset();
  assert.equal(await beforeInput('deleteContentBackward'), true, 'empty field: the delete goes to the Mac');
  await waitFor(() => opsOf('key').some((o) => o.code === 51));
});

test('Android: sticky ⌘ then a composed letter is a shortcut, not text', { skip }, async () => {
  reset();
  const [x, y] = await center('[data-mod="cmd"]');
  await gesture([[[x, y]]]);
  await cdp.send('Input.imeSetComposition', { text: 'c', selectionStart: 1, selectionEnd: 1 });
  await waitFor(() => opsOf('key').length === 1);
  assert.deepEqual(opsOf('key')[0], { op: 'key', code: 8, mods: ['cmd'], char: 'c' });
  await cdp.send('Input.insertText', { text: '' });
  await sleep(100);
  assert.equal(opsOf('text').length, 0);
});

test('Android: the back gesture closes what is open instead of leaving Rackpad', { skip }, async () => {
  await page.locator('#type-field').blur();
  const url = page.url();
  const back = async () => {
    await page.evaluate(() => history.back());
    await sleep(150);
  };
  const tap = async () => {
    const [x, y] = await center('#dock [data-tab="pad"]');
    await gesture([[[x, y]]]); // a touch arms the guard again
  };

  // A sheet: back closes it.
  await tap();
  await page.evaluate(() => document.querySelector('#open-settings').click());
  await page.waitForSelector('#settings:not([hidden])');
  await back();
  assert.equal(await page.isHidden('#settings'), true);

  // Another view: back returns to the trackpad.
  await tap();
  await show('remote');
  await back();
  assert.equal(await page.getAttribute('#app', 'data-current'), 'pad');

  // On the trackpad with nothing open: it stays, and says how to leave.
  await tap();
  await back();
  assert.equal(await page.isVisible('#toast'), true);
  assert.match(await page.textContent('#toast'), /again to leave/);
  assert.equal(page.url(), url);
  assert.equal(await page.evaluate(() => window.rackpad.conn.state), 'open');
});

test('Android: the screen streams as hardware-decodable H.264', { skip }, async () => {
  await show('screen');
  await page.waitForFunction(() => document.querySelector('#screen-video.playing')?.videoWidth > 0, null, { timeout: 8000 });
  await show('pad');
});

test('Android: a long press brings up no browser menu, except in the text field', { skip }, async () => {
  const prevented = (sel) => page.evaluate((s) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector(s).dispatchEvent(e);
    return e.defaultPrevented;
  }, sel);
  assert.equal(await prevented('#app-tab'), true);
  assert.equal(await prevented('#type-field'), false);
});

test('the Mac logs the phone platform, without trusting Chrome\'s frozen "Android 10"', () => {
  assert.equal(platformOf('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36'), ', Android');
  assert.equal(platformOf('Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'), ', Android 14');
  assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15'), ', iOS 18.2');
});

test('pairing page: phones that cannot find .local names get a code with the address', { skip }, async () => {
  const pair = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/pair', headers: { host: `localhost:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.match(pair, /id="by-address"/);
  assert.match(pair, /Android/);
  assert.equal((pair.match(/<svg/g) ?? []).length, 2, 'the .local code and the address code');
});
