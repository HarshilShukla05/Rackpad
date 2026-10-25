// Rackpad phone app: wiring between the views, the settings and the Mac.

import { Connection } from './connection.js';
import { TrackpadRecognizer, StripRecognizer } from './gestures.js';
import { bindSurface, onTap } from './touch.js';
import { TouchGlow } from './glow.js';
import { SURFACES, ACCENTS, surfaceById, accentById } from './themes.js';
import { hydrateIcons } from './icons.js';
import { feel, setHapticsEnabled } from './haptics.js';
import { Keys } from './keys.js';
import { WheelView } from './wheelview.js';
import { Smart } from './smart.js';
import { readPhoto, tokenFromLink } from './scan.js';
import { ScreenView } from './screen.js';

const $ = (sel) => document.querySelector(sel);
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(`rackpad.${k}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`rackpad.${k}`, JSON.stringify(v));
    } catch {
      // Private mode: settings just won't stick.
    }
  },
};

const VIEWS = ['pad', 'keys', 'remote', 'screen', 'app'];
const DEFAULTS = {
  surface: 'black',
  accent: 'ice',
  pointerSpeed: 1,
  scrollSpeed: 1,
  naturalScroll: true,
  strip: 'right',
  glow: true,
  ripples: true,
  beacon: true,
  haptics: true,
  liveTyping: true,
  view: 'pad',
  sideways: false, // turned the phone sideways at least once, so the tip can go
  fullscreen: true, // Android: hide Chrome's bars and the system's at the first touch
};
const UA = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(UA);
const ANDROID = /Android/.test(UA);
const settings = loadSettings();
const saveSettings = () => store.set('settings', settings);

// Settings saved by the first version carry over: couch mode is part of the
// pad now, the wheel lives in Remote, and the five themes became one look.
function loadSettings() {
  const saved = store.get('settings', {});
  const s = { ...DEFAULTS, ...saved };
  if (!('strip' in saved) && 'stripLeft' in saved) s.strip = saved.stripLeft ? 'left' : 'right';
  if (!('glow' in saved) && 'trails' in saved) s.glow = saved.trails;
  if (!VIEWS.includes(s.view)) s.view = s.view === 'wheel' ? 'remote' : 'pad';
  if (!['left', 'right', 'off'].includes(s.strip)) s.strip = 'right';
  s.surface = surfaceById(s.surface).id;
  s.accent = accentById(s.accent).id;
  for (const k of Object.keys(s)) if (!(k in DEFAULTS)) delete s[k];
  return s;
}

hydrateIcons();
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
// A long press on Android opens a menu (save image, open in new tab); only
// the text field gets one.
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest?.('textarea, input')) e.preventDefault();
});
// On a secure page Chrome on Android can install Rackpad in one tap. Kept
// from the start, since Chrome offers it soon after the page loads.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // our sheet asks instead of Chrome's banner
  installPrompt = e;
});

// ── Pairing token ───────────────────────────────────────────────────────
// The token rides in the URL so "Add to Home Screen" keeps it: home-screen
// web apps on iOS don't share storage with Safari.
const params = new URLSearchParams(location.search);
const token = params.get('k') || store.get('token', null);
if (params.get('k')) store.set('token', token);

bindScanner();
if (!token) {
  showPairing();
} else {
  if (!params.get('k')) history.replaceState(null, '', `/?k=${encodeURIComponent(token)}`);
  $('#manifest').href = `/manifest.webmanifest?k=${encodeURIComponent(token)}`;
  start();
}

// ── Pairing ─────────────────────────────────────────────────────────────
// Two ways in: scan the Mac's QR code with the phone's Camera app (the link
// opens Rackpad), or scan it from this screen. A Home Screen app keeps its own
// storage and can't see what Safari was given, so it can pair itself here.
function showPairing(message) {
  if (message) $('#pairing-msg').textContent = message;
  $('#pairing').hidden = false;
}

function bindScanner() {
  const input = $('#scan-input');
  const msg = $('#pairing-msg');
  input.addEventListener('change', async () => {
    const photo = input.files?.[0];
    input.value = ''; // so the same photo can be picked again
    if (!photo) return;
    msg.textContent = 'Reading the code…';
    try {
      const k = tokenFromLink(await readPhoto(photo));
      if (!k) {
        msg.textContent = "That photo doesn't show a Rackpad code. Try again, a little closer.";
        return;
      }
      store.set('token', k);
      location.replace(`/?k=${encodeURIComponent(k)}`);
    } catch {
      msg.textContent = "Couldn't read that photo. Try again.";
    }
  });
}

// What the Mac calls this phone. Chrome on Android no longer puts the model
// in its User-Agent, but tells a secure page when asked ("Pixel 8").
async function deviceName() {
  if (/iPhone/.test(UA)) return 'iPhone';
  if (/iPad/.test(UA)) return 'iPad';
  if (!ANDROID) return 'Browser';
  try {
    const asked = navigator.userAgentData?.getHighEntropyValues(['model']);
    const late = new Promise((resolve) => setTimeout(resolve, 300, null));
    const model = (await Promise.race([asked, late]))?.model?.trim();
    if (model) return model;
  } catch {
    // Not offered: plain HTTP, or another browser.
  }
  return 'Android phone';
}

async function start() {
  const conn = new Connection({ token, name: await deviceName() });
  const send = (msg) => conn.send(msg);
  // Any touch anywhere wakes the link up (see connection.js).
  document.addEventListener('touchstart', () => conn.use(), { capture: true, passive: true });
  const glow = new TouchGlow($('#glow'));
  const app = $('#app');
  const presence = $('#presence');
  // From the Home Screen: iOS says so; Android opens it standalone or, when
  // installed from the secure page, full screen.
  const installed = navigator.standalone || ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches);
  let lastPoint = { x: 0, y: 0 };
  let backendStatus = null;
  let version = null;
  let macName = null;
  let healthy = false;
  let idle = null;

  // ── Surfaces ──────────────────────────────────────────────────────────
  // Clicks also ring on the phone, where the finger was.
  const emit = (msg) => {
    send(msg);
    if (msg.t === 'click') glow.ring(lastPoint.x, lastPoint.y, msg.b === 'left' ? 'click' : 'right');
  };
  const padFeel = (kind) => {
    feel(kind);
    if (kind === 'grab') glow.ring(lastPoint.x, lastPoint.y, 'grab');
  };
  const glowHooks = {
    begin: stepAside,
    point: (id, x, y) => {
      lastPoint = { x, y };
      glow.point(id, x, y);
    },
    lift: (id) => glow.lift(id),
  };
  bindSurface($('#pad'), new TrackpadRecognizer(emit, { feel: padFeel }), glowHooks);
  bindSurface($('#mini-pad'), new TrackpadRecognizer(emit, { feel: padFeel }), glowHooks);

  const strip = $('#strip');
  bindSurface(strip, new StripRecognizer(send, { feel }), {
    begin: () => strip.classList.add('active'),
    lift: () => strip.classList.remove('active'),
  });

  // The Mac's name fades while you use the pad, and comes back when you stop.
  function stepAside() {
    if (!healthy) return;
    presence.classList.add('away');
    clearTimeout(idle);
    idle = setTimeout(() => presence.classList.remove('away'), 6000);
  }

  // A sweep of light across the glass, as if it just switched on.
  function wake() {
    const glass = $('#glass');
    glass.classList.remove('wake');
    void glass.offsetWidth;
    glass.classList.add('wake');
  }

  // ── Keys, remote, app controls ────────────────────────────────────────
  const keys = new Keys({
    root: $('[data-view="keys"]'),
    send,
    feel,
    live: settings.liveTyping,
    liveComposition: ANDROID,
    onLiveChange: (on) => {
      settings.liveTyping = on;
      saveSettings();
    },
  });
  const wheel = new WheelView({ root: $('[data-view="remote"]'), send, feel });
  const screenView = new ScreenView({ root: $('[data-view="screen"]'), send, feel });
  conn.addEventListener('track', (e) => screenView.attach(e.detail));
  // The stream runs only while the Screen view is on screen.
  const watchScreen = (force = false) => screenView.watch(app.dataset.current === 'screen' && document.visibilityState === 'visible', force);
  document.addEventListener('visibilitychange', () => watchScreen());
  const smart = new Smart({
    panel: $('#smart-panel'),
    send,
    feel,
    onThen: (then) => {
      if (then === 'keys') {
        showView('keys');
        keys.focus();
      }
    },
  });

  // ── Views ─────────────────────────────────────────────────────────────
  let view = settings.view;
  let magic = false;
  let typing = false; // sideways, with the keyboard up instead of the glass

  function showView(name) {
    view = VIEWS.includes(name) ? name : 'pad';
    settings.view = view;
    saveSettings();
    if (!magic) render(view);
  }

  function render(name) {
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.dataset.view === name);
    for (const b of document.querySelectorAll('#dock [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    app.dataset.current = name;
    if (name !== 'keys') $('#type-field').blur();
    if (name === 'remote') send({ t: 'getVolume' });
    watchScreen();
  }

  for (const b of document.querySelectorAll('#dock [data-tab]')) {
    onTap(b, () => {
      if (b.dataset.tab !== view) feel('tick');
      showView(b.dataset.tab);
    });
  }

  // Turned sideways, the whole phone becomes the trackpad: nothing but glass.
  // The empty space beside it holds the scroll strip and the keyboard key.
  const sideways = window.matchMedia('(orientation: landscape) and (max-height: 540px)');
  const sideKey = $('#side-key');
  function setTyping(on) {
    typing = on;
    sideKey.setAttribute('aria-pressed', String(on));
  }
  onTap(sideKey, () => {
    setTyping(!typing);
    feel('tick');
    render(typing ? 'keys' : 'pad');
    if (typing) keys.focus();
  }, { scrolls: true });

  function orient() {
    magic = sideways.matches;
    document.body.classList.toggle('magic', magic);
    setTyping(false);
    if (!magic) {
      render(view);
      return;
    }
    closeSheets();
    // Sideways, the screen fills the phone; from anywhere else, it's the trackpad.
    if (view === 'screen') {
      render('screen');
      return;
    }
    render('pad');
    wake();
    if (!settings.sideways) {
      settings.sideways = true;
      saveSettings();
      renderStatus();
    }
  }
  sideways.addEventListener('change', orient);

  // Keep the layout above the on-screen keyboard.
  const vv = window.visualViewport;
  const fit = () => {
    const h = vv ? vv.height : window.innerHeight;
    app.style.height = `${h}px`;
    app.style.transform = vv && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    document.body.classList.toggle('kb', !!vv && window.innerHeight - vv.height > 120);
  };
  vv?.addEventListener('resize', fit);
  vv?.addEventListener('scroll', fit);
  window.addEventListener('resize', fit);
  fit();

  // ── Settings ──────────────────────────────────────────────────────────
  const macSettings = () => {
    const color = accentById(settings.accent).color;
    return {
      t: 'settings',
      pointerSpeed: settings.pointerSpeed,
      scrollSpeed: settings.scrollSpeed,
      naturalScroll: settings.naturalScroll,
      beacon: settings.beacon,
      ripples: settings.ripples,
      accent: color,
      accent2: color,
    };
  };

  function applyAll() {
    const surface = surfaceById(settings.surface);
    const accent = accentById(settings.accent);
    document.documentElement.dataset.surface = surface.id;
    document.documentElement.style.setProperty('--accent', accent.color);
    $('meta[name="theme-color"]').content = surface.chrome;
    glow.setColor(accent.color, surface.light);
    glow.enabled = settings.glow;
    setHapticsEnabled(settings.haptics);
    $('#fullscreen-row').hidden = !canFullscreen;
    if (!settings.fullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    app.dataset.strip = settings.strip;
    for (const b of document.querySelectorAll('[data-pick]')) b.setAttribute('aria-pressed', String(settings[b.dataset.pick] === b.dataset.value));
    send(macSettings());
  }

  function picker(el, key, options, html) {
    el.innerHTML = options.map(html).join('');
    for (const b of el.querySelectorAll('[data-pick]')) {
      onTap(b, () => {
        settings[key] = b.dataset.value;
        saveSettings();
        applyAll();
        feel('tick');
      }, { scrolls: true });
    }
  }
  picker($('#accent-picker'), 'accent', ACCENTS, (a) => `<button class="accent-dot" data-pick="accent" data-value="${a.id}" style="--c:${a.color}" aria-label="${a.name}"></button>`);
  picker($('#surface-picker'), 'surface', SURFACES, (s) => `<button data-pick="surface" data-value="${s.id}">${s.name}</button>`);
  picker($('#strip-picker'), 'strip', [{ id: 'left', name: 'Left' }, { id: 'right', name: 'Right' }, { id: 'off', name: 'Off' }],
    (o) => `<button data-pick="strip" data-value="${o.id}">${o.name}</button>`);

  const ranges = [
    ['#s-pointer', '#o-pointer', 'pointerSpeed'],
    ['#s-scroll', '#o-scroll', 'scrollSpeed'],
  ];
  for (const [inp, out, key] of ranges) {
    const el = $(inp);
    el.value = settings[key];
    $(out).textContent = `${Number(settings[key]).toFixed(2)}×`;
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      $(out).textContent = `${settings[key].toFixed(2)}×`;
      saveSettings();
      send(macSettings());
    });
  }
  const toggles = [
    ['#s-natural', 'naturalScroll'],
    ['#s-glow', 'glow'],
    ['#s-beacon', 'beacon'],
    ['#s-ripples', 'ripples'],
    ['#s-haptics', 'haptics'],
    ['#s-fullscreen', 'fullscreen'],
  ];
  for (const [sel, key] of toggles) {
    const el = $(sel);
    el.checked = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      saveSettings();
      applyAll();
    });
  }

  const sheets = { settings: $('#settings'), install: $('#install'), secure: $('#secure') };
  const backdrop = $('#backdrop');
  function openSheet(name) {
    for (const [n, el] of Object.entries(sheets)) el.hidden = n !== name;
    backdrop.hidden = false;
  }
  function closeSheets() {
    for (const el of Object.values(sheets)) el.hidden = true;
    backdrop.hidden = true;
  }
  onTap($('#open-settings'), () => {
    updateAbout();
    openSheet('settings');
    feel('tick');
  });
  $('#settings-done').addEventListener('click', closeSheets);
  $('#secure-done').addEventListener('click', closeSheets);
  $('#install-done').addEventListener('click', () => {
    store.set('installTipShown', true);
    closeSheets();
    installPrompt?.prompt().catch(() => {});
    installPrompt = null;
  });
  backdrop.addEventListener('click', closeSheets);

  // ── Android: full screen, and the back gesture ────────────────────────
  // Chrome on Android can hide its bars and the system's (an iPhone can't),
  // but only when asked from a touch, so the first touch asks. And Android's
  // back gesture is a swipe in from either edge, right where a thumb lands on
  // the trackpad: a step in history catches it, so back closes what's open
  // instead of leaving Rackpad. Both need a lifted finger (a user activation),
  // hence touchend; Chrome skips history steps added without one.
  const canFullscreen = ANDROID && document.fullscreenEnabled === true;
  let guarded = false;
  document.addEventListener('touchend', () => {
    if (canFullscreen && settings.fullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    if (ANDROID && !guarded) {
      history.pushState({ rackpad: 'back' }, '');
      guarded = true;
    }
  }, { capture: true, passive: true });

  window.addEventListener('popstate', () => {
    if (!ANDROID || !guarded) return;
    guarded = false; // the next touch catches the next back
    if (!stepBack()) toast('Swipe back again to leave');
  });

  // Back closes a sheet, puts the keyboard away, or returns to the trackpad.
  function stepBack() {
    if (Object.values(sheets).some((el) => !el.hidden)) {
      closeSheets();
      return true;
    }
    if (typing) {
      setTyping(false);
      render('pad');
      return true;
    }
    if (!magic && view !== 'pad') {
      showView('pad');
      return true;
    }
    return false;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2200);
  }

  // ── Secure connection ─────────────────────────────────────────────────
  // The Mac serves the same app over HTTPS with its own certificate (see
  // server/tls.js). Once the phone trusts that certificate, the secure page
  // answers, and the mic and live camera become available there.
  const secureNow = location.protocol === 'https:';
  let secureInfo = null; // { port, ca } from the Mac
  const secureUrl = () => `https://${location.hostname}:${secureInfo.port}`;

  function renderSecureRow() {
    const state = $('#secure-state');
    state.textContent = secureNow ? 'On' : secureInfo ? 'Set up' : 'Unavailable';
    state.parentElement.classList.toggle('on', secureNow);
  }

  async function secureReady() {
    try {
      const res = await fetch(`${secureUrl()}/secure-check`, { cache: 'no-store' });
      return res.ok;
    } catch {
      return false; // the phone doesn't trust the certificate yet
    }
  }

  async function checkSecure() {
    const btn = $('#secure-open');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const ok = await secureReady();
    btn.disabled = false;
    btn.textContent = ok ? 'Open secure Rackpad' : 'Check again';
    btn.dataset.ready = String(ok);
  }

  function openSecureSheet() {
    for (const li of document.querySelectorAll('#secure-steps [data-os]')) li.hidden = li.dataset.os !== (ANDROID ? 'android' : 'ios');
    for (const el of document.querySelectorAll('.ca-name')) el.textContent = secureInfo?.ca ?? 'Rackpad Local CA';
    if (ANDROID) {
      // Android installs a certificate from Settings, not from the download.
      $('#secure-dl-note').textContent = 'Chrome saves it to Downloads.';
      $('#secure-note').textContent = "Then install the secure Rackpad from Chrome's ⋮ menu, and delete the old icon.";
    } else if (installed) {
      // A Home Screen app may not hand the certificate to Settings; Safari does.
      $('#secure-dl-note').textContent = `If nothing downloads, open ${location.origin}/rackpad.crt in Safari.`;
    }
    $('#secure-lead').textContent = secureNow
      ? 'This phone is connected securely, so the microphone and live camera can work.'
      : secureInfo
        ? 'Lets Rackpad use the microphone and the live camera. Once per phone, about a minute. Everything stays on your Wi-Fi.'
        : 'Your Mac is running Rackpad without HTTPS. Start it without --no-https to set this up.';
    for (const el of [$('#secure-steps'), $('#secure-open'), $('#secure-note')]) el.hidden = secureNow || !secureInfo;
    openSheet('secure');
    if (!secureNow && secureInfo) checkSecure();
  }

  onTap($('#open-secure'), openSecureSheet, { scrolls: true });
  $('#secure-open').addEventListener('click', () => {
    if ($('#secure-open').dataset.ready === 'true') location.href = `${secureUrl()}/?k=${encodeURIComponent(token)}`;
    else checkSecure();
  });

  function updateAbout() {
    const parts = [`Rackpad ${version ?? ''}`.trim()];
    if (macName) parts.push(macName);
    if (conn.latency !== null) parts.push(`${conn.latency} ms`);
    $('#about').textContent = parts.join(' · ');
  }

  // ── Connection & status ───────────────────────────────────────────────

  // Round trip to the Mac, always in a corner: the middle of the last
  // several, so one slow Wi-Fi moment doesn't make it flicker.
  const trips = [];
  function renderPing() {
    if (conn.state !== 'open') trips.length = 0;
    const sorted = [...trips].sort((a, b) => a - b);
    const ms = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    $('#ping-ms').textContent = ms === null ? '–' : `${ms} ms`;
    $('#ping').dataset.level = ms === null ? (conn.state === 'unauthorized' ? 'bad' : 'wait') : ms <= 40 ? 'ok' : ms <= 100 ? 'wait' : 'bad';
  }

  function renderStatus() {
    const s = conn.state;
    const b = backendStatus;
    let name = 'Connecting…';
    let note = '';
    let level = 'wait';
    if (s === 'open') {
      name = macName ?? 'Your Mac';
      level = 'ok';
      if (b?.kind === 'dry-run') {
        note = 'Dry run: nothing on the Mac moves';
        level = 'wait';
      } else if (b?.error) {
        note = b.error;
        level = 'bad';
      } else if (b && !b.ready) {
        note = 'Starting on your Mac…';
        level = 'wait';
      } else if (b && !b.trusted) {
        note = 'On your Mac, allow Accessibility for the app Rackpad runs in';
        level = 'bad';
      }
    } else if (s === 'closed') {
      name = 'Reconnecting…';
      note = conn.reason ?? '';
    } else if (s === 'unsupported') {
      name = "Can't connect";
      note = conn.reason ?? '';
      level = 'bad';
    } else if (s === 'unauthorized') {
      name = 'Not paired';
      level = 'bad';
    }
    if (level === 'ok') {
      if (IOS && !installed) note = 'Add to Home Screen for full screen';
      else if (!settings.sideways) note = 'Turn sideways for a bigger trackpad';
    }
    healthy = level === 'ok';
    if (!healthy) presence.classList.remove('away');
    presence.dataset.state = s;
    presence.dataset.level = level;
    $('#mac-name').textContent = name;
    $('#presence-note').textContent = note;
  }

  conn.addEventListener('state', (e) => {
    renderStatus();
    renderPing();
    if (e.detail === 'open') {
      send(macSettings());
      wake();
      watchScreen(true); // a new connection: ask for the screen again if it's showing
    }
    if (e.detail === 'unauthorized') showPairing("This phone's pairing code is no longer valid. Scan the QR code on your Mac again.");
  });
  conn.addEventListener('latency', (e) => {
    trips.push(e.detail);
    if (trips.length > 15) trips.shift();
    updateAbout();
    renderPing();
  });
  conn.addEventListener('message', (e) => {
    const msg = e.detail;
    switch (msg.t) {
      case 'welcome':
        version = msg.version;
        macName = msg.mac?.name;
        backendStatus = msg.backend;
        secureInfo = msg.secure ?? null;
        renderSecureRow();
        setContext(msg);
        renderStatus();
        maybeShowInstallTip();
        break;
      case 'status':
        backendStatus = msg.backend;
        renderStatus();
        break;
      case 'context':
        setContext(msg);
        break;
      case 'volume':
        wheel.showVolume(msg);
        break;
      case 'screen':
        screenView.status(msg);
        break;
      case 'screenOff':
        screenView.screenOff(msg.on);
        break;
      default:
        break;
    }
  });

  // The app tab wears the icon of whatever app is in front on the Mac.
  function setContext({ app: frontApp, profile }) {
    if (!profile) return;
    smart.set({ app: frontApp ?? {}, profile });
    const img = $('#app-icon');
    const hasIcon = !!frontApp?.icon;
    if (hasIcon) img.src = frontApp.icon;
    img.hidden = !hasIcon;
    $('#app-fallback').hidden = hasIcon;
    $('#app-tab').setAttribute('aria-label', `${frontApp?.name || profile.title} controls`);
  }

  // In the browser its bars eat the trackpad; on the Home Screen it's all glass.
  function maybeShowInstallTip() {
    if (!(IOS || ANDROID) || installed || store.get('installTipShown', false)) return;
    setTimeout(() => {
      if (magic) return;
      const os = IOS ? 'ios' : installPrompt ? 'android-install' : 'android';
      for (const p of document.querySelectorAll('#install [data-os]')) p.hidden = p.dataset.os !== os;
      $('#install-done').textContent = installPrompt ? 'Install' : 'Got it';
      openSheet('install');
    }, 900);
  }

  applyAll();
  orient();
  conn.connect();
  window.rackpad = { conn, settings, showView, screenView }; // handy from the console
}
