// End-to-end checks for scripts/record.mjs: real Chromium, real ffmpeg, tiny local pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scripts = join(import.meta.dirname, '..', 'scripts');
const recorder = join(scripts, 'record.mjs');
const onPath = (bin) => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
};
const hasModules = existsSync(join(scripts, 'node_modules', 'playwright-core'));
const chromium = hasModules && (await import(join(scripts, 'node_modules', 'playwright-core', 'index.mjs'))).chromium;
const missing = [
  !hasModules && 'scripts/node_modules (npm install)',
  hasModules && !process.env.VIDEO_QA_CHANNEL && !existsSync(chromium.executablePath()) && 'Playwright Chromium',
  ...['ffmpeg', 'ffprobe', 'fc-match'].filter((bin) => !onPath(bin)),
].filter(Boolean);
// Homebrew's default ffmpeg has no drawtext or subtitles filter; the recorder needs both (SKILL.md, ffmpeg-full).
if (onPath('ffmpeg')) {
  const filters = execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString();
  missing.push(...['drawtext', 'subtitles'].filter((f) => !new RegExp(`\\s${f}\\s`).test(filters)).map((f) => `ffmpeg with ${f}`));
}
// CI sets VIDEO_QA_REQUIRE_DEPS=1 so missing tools fail the run instead of skipping it.
if (missing.length && process.env.VIDEO_QA_REQUIRE_DEPS === '1') throw new Error(`video-qa tests need ${missing.join(', ')}`);
const skip = missing.length ? `needs ${missing.join(', ')}` : false;

const VIEWPORT = { width: 640, height: 360 };
const BANNER_HEIGHT = 56;

// BEFORE shows no message after Sign in; AFTER shows it. #go exists on both unless told otherwise.
const page = ({ fixed, button = true }) => `<!doctype html><title>t</title>
  <input id="email">${button ? '<button id="go">Sign in</button>' : ''}<p id="msg"></p>
  <script>document.getElementById('go')?.addEventListener('click', () => {
    ${fixed ? "document.getElementById('msg').textContent = 'Invalid email or password';" : ''}
  });</script>`;

function serve(html, delayMs = 0) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => setTimeout(() => res.end(html), delayMs));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

async function closedPortUrl() {
  const server = await serve('');
  const url = urlOf(server);
  await new Promise((resolve) => server.close(resolve));
  return url;
}

function scenario(title, beforeUrl, afterUrl) {
  return {
    id: 'flow', title, pace: 'fast', viewport: VIEWPORT, sideBySide: false,
    versions: [
      { label: 'BEFORE', detail: 'base 111', baseUrl: beforeUrl },
      { label: 'AFTER', detail: 'fix 222', baseUrl: afterUrl },
    ],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption: 'Click Sign in', action: 'click', selector: '#go', timeoutMs: 1500, holdMs: 100 },
      { caption: 'See message', action: 'expect_text', text: 'Invalid email or password', timeoutMs: 1000, holdMs: 100 },
    ],
  };
}

function record(spec, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'video-qa-test-'));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(spec));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [recorder, join(dir, 'scenario.json'), dir, ...args]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.on('close', (code) => {
      const results = existsSync(join(dir, 'results.json'))
        ? JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) : null;
      resolve({ dir, code, stderr, results });
    });
  });
}

async function withServers(pages, fn) {
  const servers = await Promise.all(pages.map(serve));
  try {
    return await fn(servers.map(urlOf));
  } finally {
    servers.forEach((server) => server.close());
  }
}

const duration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', file]).toString().trim());

// The end of the last caption in an .srt, in seconds.
const lastCueEnd = (file) => {
  const [, h, m, sec, ms] = readFileSync(file, 'utf8').match(/--> (\d+):(\d+):(\d+),(\d+)\s*\n(?![\s\S]*-->)/);
  return h * 3600 + m * 60 + Number(sec) + ms / 1000;
};

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Frames of a clip whose bottom page rows are the frame check's magenta edge marker.
const magentaFrames = (file) => {
  const filter = `crop=iw:2:0:${VIEWPORT.height - 4},signalstats,metadata=mode=print:file=-`;
  const log = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', filter, '-f', 'null', '-']).toString();
  return [...log.matchAll(/UMIN=([\d.]+)[\s\S]*?VMIN=([\d.]+)/g)].filter(([, u, v]) => u > 180 && v > 180).length;
};

const frameHeight = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=height', '-of', 'csv=p=0', file]).toString().trim());

test('a check failing on BEFORE and passing on AFTER is FIXED, and --full adds the combined film with % titles and banners', { skip }, async () => {
  const run = await withServers([page({ fixed: false }), page({ fixed: true })],
    ([before, after]) => record(scenario('Discount shows 20% off', before, after), ['--full']));
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.results.verdict, 'FIXED');
    assert.doesNotMatch(run.stderr, /Stray %/);
    // Captions sit in a strip below the page; the shareable clips have the same strip but no banner.
    const clean = frameHeight(join(run.dir, 'flow-before.mp4'));
    assert.ok(clean > VIEWPORT.height);
    assert.equal(frameHeight(join(run.dir, 'flow-after.mp4')), clean);
    assert.equal(frameHeight(join(run.dir, 'before.mp4')), clean + BANNER_HEIGHT);
    assert.equal(frameHeight(join(run.dir, 'title.mp4')), clean + BANNER_HEIGHT);
    assert.equal(run.results.video, join(run.dir, 'flow.mp4'));
    assert.ok(existsSync(run.results.video));
    assert.deepEqual(run.results.versions.map((v) => v.cleanClip),
      [join(run.dir, 'flow-before.mp4'), join(run.dir, 'flow-after.mp4')]);
    for (const slug of ['before', 'after']) {
      assert.ok(lastCueEnd(join(run.dir, `${slug}.srt`)) <= duration(join(run.dir, `flow-${slug}.mp4`)));
    }
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('a BEFORE server that is down gives INCOMPLETE, not FIXED', { skip }, async () => {
  const before = await closedPortUrl();
  const run = await withServers([page({ fixed: true })], ([after]) => record(scenario('Down', before, after)));
  try {
    assert.equal(run.code, 2, run.stderr);
    assert.equal(run.results.verdict, 'INCOMPLETE');
    assert.equal(run.results.versions[0].aborted, true);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('a selector that exists only on AFTER gives INCOMPLETE, not FIXED', { skip }, async () => {
  const run = await withServers([page({ fixed: false, button: false }), page({ fixed: true })],
    ([before, after]) => record(scenario('Missing button', before, after)));
  try {
    assert.equal(run.code, 2, run.stderr);
    assert.equal(run.results.verdict, 'INCOMPLETE');
    assert.deepEqual(run.results.versions[0].results.map((r) => [r.kind, r.ok]),
      [['action', true], ['action', false], ['check', false]]);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('a page not drawn to the edges of the video frame gives INCOMPLETE', { skip }, async () => {
  // A greyscale filter greys the recorder's magenta edge markers, as a browser that leaves part of the frame grey would.
  const grey = (fixed) => page({ fixed }).replace('<title>t</title>', '<title>t</title><style>html{filter:grayscale(1)}</style>');
  const run = await withServers([grey(false), page({ fixed: true })],
    ([before, after]) => record(scenario('Grey frame', before, after)));
  try {
    assert.equal(run.code, 2, run.stderr);
    assert.equal(run.results.verdict, 'INCOMPLETE');
    assert.match(run.results.versions[0].frameCheck.note, /did not fill the video frame/);
    assert.equal(run.results.versions[1].frameCheck.ok, true);
    assert.equal(magentaFrames(join(run.dir, 'flow-after.mp4')), 0);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('a page that covers the viewport edges at the end skips the frame check instead of failing it', { skip }, async () => {
  const modal = (fixed) => page({ fixed }).replace('</script>', `</script><dialog id="d">Error</dialog>
    <style>dialog::backdrop{background:rgba(0,0,0,.5)}</style>
    <script>document.getElementById('go').addEventListener('click', () => document.getElementById('d').showModal());</script>`);
  const run = await withServers([modal(false), modal(true)], ([before, after]) => record(scenario('Modal', before, after)));
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.results.verdict, 'FIXED');
    assert.match(run.results.versions[0].frameCheck.skipped, /covers the viewport edges/);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('--captions off drops the caption strip, and without --full there is no combined film', { skip }, async () => {
  const run = await withServers([page({ fixed: false }), page({ fixed: true })],
    ([before, after]) => record(scenario('No captions', before, after), ['--captions=off']));
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.results.captions, false);
    assert.equal(frameHeight(join(run.dir, 'flow-before.mp4')), VIEWPORT.height);
    assert.equal(magentaFrames(join(run.dir, 'flow-before.mp4')), 0);
    assert.equal(magentaFrames(join(run.dir, 'flow-after.mp4')), 0);
    assert.equal(run.results.video, null);
    assert.ok(!existsSync(join(run.dir, 'flow.mp4')));
    assert.ok(!existsSync(join(run.dir, 'before.mp4')));
    assert.ok(existsSync(join(run.dir, 'before.srt')));
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('slow page loads and a failing check wait are cut, and the caption keeps the real wait', { skip }, async () => {
  const spec = (trimWaits) => ({
    ...scenario('Slow', null, null), trimWaits,
    versions: [{ label: 'BEFORE', baseUrl: urlOf(slow) }],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption: 'See message', action: 'expect_text', text: 'Invalid email or password', timeoutMs: 2500, holdMs: 100 },
    ],
  });
  const slow = await serve(page({ fixed: false }), 1500);
  const runs = [];
  try {
    runs.push(await record(spec(true)), await record(spec(false)));
    const [trimmed, real] = runs;
    assert.equal(trimmed.code, 1, trimmed.stderr);
    assert.ok(trimmed.results.versions[0].trimmedMs > 2500, `cut ${trimmed.results.versions[0].trimmedMs}ms`);
    assert.equal(real.results.versions[0].trimmedMs, 0);
    assert.ok(duration(join(real.dir, 'flow-before.mp4')) - duration(join(trimmed.dir, 'flow-before.mp4')) > 2.5);
    assert.match(trimmed.results.versions[0].results[1].note, /\(waited [2-3]\.\ds\)$/);
    assert.ok(trimmed.results.versions[0].results[1].waitedMs >= 2500);
    assert.match(readFileSync(join(trimmed.dir, 'before.srt'), 'utf8'), /FAIL: .*\(waited [2-3]\.\ds\)/);
  } finally {
    slow.close();
    runs.forEach((run) => rmSync(run.dir, { recursive: true, force: true }));
  }
});

test('a page load started by a click is cut too', { skip }, async () => {
  const server = createServer((req, res) => (req.url === '/next'
    ? setTimeout(() => res.end('<!doctype html><p id="done">Next page</p>'), 1500)
    : res.end('<!doctype html><a id="go" href="/next">Next</a>')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const spec = (trimWaits) => ({
    ...scenario('Click load', null, null), trimWaits,
    versions: [{ label: 'AFTER', baseUrl: urlOf(server) }],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption: 'Click Next', action: 'click', selector: '#go', holdMs: 100 },
      { caption: 'See next page', action: 'expect_visible', selector: '#done', holdMs: 100 },
    ],
  });
  const runs = [];
  try {
    runs.push(await record(spec(true)), await record(spec(false)));
    const [trimmed, real] = runs;
    assert.equal(trimmed.code, 0, trimmed.stderr);
    assert.ok(trimmed.results.versions[0].trimmedMs > 1000, `cut ${trimmed.results.versions[0].trimmedMs}ms`);
    assert.equal(real.results.versions[0].trimmedMs, 0);
  } finally {
    server.close();
    runs.forEach((run) => rmSync(run.dir, { recursive: true, force: true }));
  }
});

test('a click on a link that loads no page (a 204 or a download) does not stall the step', { skip }, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/empty') return setTimeout(() => { res.statusCode = 204; res.end(); }, 300);
    if (req.url === '/file') {
      res.setHeader('Content-Disposition', 'attachment; filename="a.txt"');
      return res.end('file');
    }
    return res.end('<!doctype html><a id="empty" href="/empty">Empty</a> <a id="file" href="/file">File</a><p id="ok">ok</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const spec = {
    ...scenario('No page', null, null), trimWaits: false,
    versions: [{ label: 'AFTER', baseUrl: urlOf(server) }],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption: 'Click Empty', action: 'click', selector: '#empty', holdMs: 100 },
      { caption: 'Click File', action: 'click', selector: '#file', holdMs: 100 },
      { caption: 'Still here', action: 'expect_visible', selector: '#ok', holdMs: 100 },
    ],
  };
  const started = Date.now();
  const run = await record(spec);
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.ok(duration(join(run.dir, 'flow-after.mp4')) < 6, 'a click waited for a page that never came');
    assert.ok(Date.now() - started < 20000);
  } finally {
    server.close();
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('a fetch that never ends, from page load or a click, stalls neither the goto nor the click', { skip }, async () => {
  // One hung fetch starts on load (a long poll), another with the click; the click's own fetch returns.
  const server = await listen((req, res) => {
    if (req.url === '/hang') return res.flushHeaders();
    if (req.url === '/data') return res.end('Loaded');
    return res.end(`<!doctype html><button id="go">Load</button><p id="box"></p><script>
      fetch('/hang');
      document.getElementById('go').onclick = async () => {
        fetch('/hang');
        document.getElementById('box').textContent = await (await fetch('/data')).text();
      };</script>`);
  });
  const run = await record({
    ...scenario('Hung fetch', null, null), trimWaits: false,
    versions: [{ label: 'AFTER', baseUrl: urlOf(server) }],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption: 'Click Load', action: 'click', selector: '#go', holdMs: 100 },
      { caption: 'See result', action: 'expect_text', text: 'Loaded', timeoutMs: 1000, holdMs: 100 },
    ],
  });
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.ok(duration(join(run.dir, 'flow-after.mp4')) < 6, 'a step waited for a fetch that never ends');
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(run.dir, { recursive: true, force: true });
  }
});

// Each one-version run: an action whose 1.5s of network activity should be cut from the video.
async function assertActionWaitCut(caption, homeHtml, action, slowPath) {
  const server = await listen((req, res) => (req.url.startsWith(slowPath)
    ? setTimeout(() => res.end('<!doctype html><p id="done">Done</p>'), 1500)
    : res.end(homeHtml)));
  const run = await record({
    ...scenario(caption, null, null),
    versions: [{ label: 'AFTER', baseUrl: urlOf(server) }],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption, ...action, holdMs: 100 },
      { caption: 'See result', action: 'expect_visible', selector: '#done', timeoutMs: 1000, holdMs: 100 },
    ],
  });
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.results.versions[0].trimmedMs > 1000, `cut ${run.results.versions[0].trimmedMs}ms`);
    assert.equal(typeof run.results.versions[0].results[2].waitedMs, 'number');
  } finally {
    server.close();
    rmSync(run.dir, { recursive: true, force: true });
  }
}

test('a click that swaps content via fetch has its wait cut', { skip }, () => assertActionWaitCut('Click Load',
  `<!doctype html><button id="go">Load</button><div id="box"></div><script>
    document.getElementById('go').onclick = async () => {
      document.getElementById('box').innerHTML = await (await fetch('/data')).text();
    };</script>`,
  { action: 'click', selector: '#go' }, '/data'));

test('a select that auto-submits its form has the page load cut', { skip }, () => assertActionWaitCut('Pick B',
  `<!doctype html><form action="/next"><select id="pick" name="p" onchange="this.form.submit()">
    <option>a</option><option>b</option></select></form>`,
  { action: 'select', selector: '#pick', value: 'b' }, '/next'));

test('invalid flags and scenarios exit 2 before recording', { skip }, async () => {
  const valid = scenario('Invalid', 'http://127.0.0.1:1', 'http://127.0.0.1:2');
  const runs = await Promise.all([
    record(valid, ['--captions', 'maybe']),
    record({ ...valid, captions: 'off' }),
    record({ ...valid, viewport: { width: 641, height: 360 } }),
    record(valid, ['--full=yes']),
  ]);
  try {
    assert.deepEqual(runs.map((run) => run.code), [2, 2, 2, 2]);
    assert.match(runs[1].stderr, /captions must be true or false/);
    assert.match(runs[2].stderr, /viewport width and height must be even/);
  } finally {
    runs.forEach((run) => rmSync(run.dir, { recursive: true, force: true }));
  }
});

// Enter reports what check, hover, type and fill left on the page; scrolling to the bottom reports itself.
const formPage = `<!doctype html><title>t</title>
  <label><input id="agree" type="checkbox"> Agree</label> <span id="help">Help</span>
  <input id="name" value="Ada"> <input id="email"><p id="summary"></p><p id="scrolled"></p>
  <div style="height:2000px"></div><p id="bottom">Bottom</p>
  <script>
    const $ = (id) => document.getElementById(id);
    let hovered = false;
    $('help').addEventListener('mouseenter', () => { hovered = true; });
    $('email').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('summary').textContent = [$('email').value, $('name').value, $('agree').checked, hovered].join('|');
    });
    addEventListener('scroll', () => { if (scrollY > 0) $('scrolled').textContent = 'scrolled down'; });
  </script>`;

test('human pacing records a working flow through check, hover, type, fill, press and scroll', { skip }, async () => {
  const run = await withServers([formPage], ([after]) => record({
    ...scenario('Human', null, null), pace: undefined, versions: [{ label: 'AFTER', baseUrl: after }],
    steps: [
      { caption: 'Open', action: 'goto', url: '/', holdMs: 100 },
      { caption: 'Agree', action: 'check', selector: '#agree', holdMs: 100 },
      { caption: 'Hover help', action: 'hover', selector: '#help', holdMs: 100 },
      { caption: 'Add surname', action: 'type', selector: '#name', value: ' Lovelace', holdMs: 100 },
      { caption: 'Enter email', action: 'fill', selector: '#email', value: 'a@b.co', holdMs: 100 },
      { caption: 'Press Enter', action: 'press', key: 'Enter', holdMs: 100 },
      { caption: 'See summary', action: 'expect_text', selector: '#summary', text: 'a@b.co|Ada Lovelace|true|true', holdMs: 100 },
      { caption: 'Scroll down', action: 'scroll', selector: '#bottom', holdMs: 100 },
      { caption: 'See scrolled', action: 'expect_text', selector: '#scrolled', text: 'scrolled down', holdMs: 100 },
    ],
  }));
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.results.verdict, 'WORKING');
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});
