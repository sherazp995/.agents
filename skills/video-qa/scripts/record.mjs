#!/usr/bin/env node
// Records one captioned video per version of a scenario; with --full, also joins them into
// a single before/after film with title cards. See ../SKILL.md for the format.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const EXPECT_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 10000;
const NAVIGATION_TIMEOUT_MS = 30000;
const BANNER_HEIGHT = 56;
const CAPTION_MARGIN = 24;
const STRIP_COLOUR = '0x111827';
const CARD_SECONDS = 3;
const FPS = 25;
// Magenta, rare on real pages, so a frame showing it at the edges really has the page drawn there.
const EDGE_MARKER = { css: '#ff00ff', size: 8 };
// Waits (page loads, checks polling for something) are cut from the video, keeping this much of each end.
const LOAD_EDGE_MS = 150;
const CHECK_EDGE_MS = 300;
// How long an action's page load or fetch may take to start, and the network quiet that ends it.
const SETTLE_MS = 300;
// The longest an action waits for its fetch/XHR traffic, so a request that never ends (polling, a hung fetch) cannot stall a step.
const TRAFFIC_WAIT_MS = 2000;

const USAGE = 'usage: record.mjs <scenario.json> [output-dir] [--captions on|off] [--full]';
const argv = process.argv.slice(2);
const fullAt = argv.findIndex((arg) => /^--full(=|$)/.test(arg));
const fullFlag = fullAt !== -1 && argv.splice(fullAt, 1)[0];
if (fullFlag && fullFlag !== '--full') {
  console.error(USAGE);
  process.exit(2);
}
let captionsFlag;
const flagAt = argv.findIndex((arg) => /^--captions(=|$)/.test(arg));
if (flagAt !== -1) {
  const [flag] = argv.splice(flagAt, 1);
  captionsFlag = flag.includes('=') ? flag.split('=')[1] : argv.splice(flagAt, 1)[0];
  if (!['on', 'off'].includes(captionsFlag)) {
    console.error(USAGE);
    process.exit(2);
  }
}
const [scenarioPath, outArg] = argv;
if (!scenarioPath) {
  console.error(USAGE);
  process.exit(2);
}

const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
// --captions overrides the scenario's "captions"; without captions there is no caption strip and holds are shorter.
const CAPTIONS = captionsFlag ? captionsFlag === 'on' : scenario.captions !== false;
const TRIM = scenario.trimWaits !== false;
// --full overrides the scenario's "full": it adds the combined film, the banner clips and side-by-side.
const FULL = Boolean(fullFlag) || scenario.full === true;
const outDir = resolve(outArg || join(dirname(resolve(scenarioPath)), 'video'));
const viewport = scenario.viewport || { width: 1280, height: 800 };
// The banner gets its own strip above the page and the captions their own strip below it,
// so neither ever hides part of the page. The caption strip height is set once all captions are known.
const frame = { width: viewport.width, height: viewport.height + BANNER_HEIGHT };
let stripHeight = 0;
// libass sizes SRT fonts against a 288px-high script; this keeps the size captions had over a bannered frame.
const CAPTION_PX = Math.round(20 * (viewport.height + BANNER_HEIGHT) / 288);

// Human pacing: a visible cursor glides to each target, typing has an uneven rhythm,
// and there is a short varied pause before every action. "pace": "fast" turns it off.
const HUMAN = scenario.pace !== 'fast';
const jitter = (min, max) => min + Math.random() * (max - min);
const pause = (page, min, max) => (HUMAN ? page.waitForTimeout(jitter(min, max)) : null);
// Time to read a step's caption before acting, and to see its result after; a check shows PASS or FAIL, so it holds longer.
const READ_PAUSE_MS = CAPTIONS ? [250, 500] : [80, 200];
const HOLD_MS = CAPTIONS ? { action: 700, check: 1500 } : { action: 350, check: 700 };

// Headless recordings have no OS pointer, so draw one that follows the mouse and pulses on click.
const CURSOR_SCRIPT = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;'
      + 'left:-40px;top:-40px;transition:transform .12s;'
      + 'background:url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 22 22%27>'
      + '<path d=%27M2 1l15 11-6.5 1.2L14 20l-3 1.3-3.4-6.9L2 18z%27 fill=%27black%27 stroke=%27white%27 stroke-width=%271.4%27/></svg>") no-repeat';
    document.documentElement.appendChild(c);
    document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { c.style.transform = 'scale(.8)'; }, true);
    document.addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  });`;

let mouse = { x: 640, y: 360 };
// One quick eased glide (0.2 to 0.45s), fast at the start and settling on the target, like a hand on a mouse.
async function glide(page, x, y) {
  const from = mouse;
  const duration = Math.min(450, Math.max(200, Math.hypot(x - from.x, y - from.y) * 0.6));
  const steps = Math.max(6, Math.round(duration / 25));
  for (let i = 1; i <= steps; i += 1) {
    const eased = 1 - (1 - i / steps) ** 3;
    await page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
    await page.waitForTimeout(duration / steps);
  }
  mouse = { x, y };
}

// acted.at records when the action itself took place, after the cursor glide and the typing, so a cut never removes them.
async function moveTo(page, selector, acted) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  if (!HUMAN) return target;
  const box = await target.boundingBox();
  if (box) {
    await glide(page, box.x + box.width * jitter(0.35, 0.65), box.y + box.height * jitter(0.35, 0.65));
    await pause(page, 60, 150);
  }
  acted.at = Date.now();
  return target;
}

async function humanType(page, selector, value, clear, acted) {
  const target = await moveTo(page, selector, acted);
  await target.click();
  // fill starts empty; type appends, so put the caret after the existing text.
  if (clear) await target.fill('');
  else await target.press('End');
  // Long values type faster, so a pasted-length string does not drag the video.
  const speed = Math.min(1, 30 / value.length);
  if (!HUMAN) await page.keyboard.type(value);
  else {
    for (const ch of value) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(Math.max(12, speed * (ch === ' ' || ch === '@' ? jitter(80, 160) : jitter(30, 80))));
    }
  }
  acted.at = Date.now();
}

const ACTIONS = {
  // Waits for the load, then for network quiet up to TRAFFIC_WAIT_MS, so a page that keeps a request open (polling, a long poll) still opens.
  goto: async (page, s, base) => {
    await page.goto(new URL(s.url, base).href, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: TRAFFIC_WAIT_MS }).catch(() => {});
  },
  click: async (page, s, base, acted) => (await moveTo(page, s.selector, acted)).click(),
  fill: (page, s, base, acted) => humanType(page, s.selector, String(s.value ?? ''), true, acted),
  type: (page, s, base, acted) => humanType(page, s.selector, String(s.value ?? ''), false, acted),
  press: (page, s) => page.keyboard.press(s.key),
  select: async (page, s, base, acted) => (await moveTo(page, s.selector, acted)).selectOption(s.value),
  hover: (page, s, base, acted) => moveTo(page, s.selector, acted),
  check: async (page, s, base, acted) => (await moveTo(page, s.selector, acted)).check(),
  wait: (page, s) => page.waitForTimeout(s.ms ?? 1000),
  wait_for: (page, s) => page.locator(s.selector).first().waitFor(),
  scroll: (page, s, base, acted) => moveTo(page, s.selector, acted),
};

const EXPECTATIONS = {
  expect_visible: (page, s) => page.locator(s.selector).first()
    .waitFor({ state: 'visible', timeout: s.timeoutMs ?? EXPECT_TIMEOUT_MS }),
  expect_hidden: (page, s) => page.locator(s.selector).first()
    .waitFor({ state: 'hidden', timeout: s.timeoutMs ?? EXPECT_TIMEOUT_MS }),
  expect_text: async (page, s) => {
    const deadline = Date.now() + (s.timeoutMs ?? EXPECT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if ((await page.locator(s.selector || 'body').first().innerText()).includes(s.text)) return;
      await page.waitForTimeout(200);
    }
    throw new Error(`text not found: ${s.text}`);
  },
  expect_url: async (page, s) => {
    await page.waitForURL((url) => url.href.includes(s.contains), { timeout: s.timeoutMs ?? EXPECT_TIMEOUT_MS });
  },
  expect_count: async (page, s) => {
    const deadline = Date.now() + (s.timeoutMs ?? EXPECT_TIMEOUT_MS);
    let count;
    while (Date.now() < deadline) {
      count = await page.locator(s.selector).count();
      if (count === s.count) return;
      await page.waitForTimeout(200);
    }
    throw new Error(`expected ${s.count} matches, saw ${count}`);
  },
};

const ROLES = ['before', 'after'];

function roleOf(version) {
  if (version.role !== undefined) return String(version.role).toLowerCase();
  if (/before/i.test(version.label)) return 'before';
  return /after/i.test(version.label) ? 'after' : null;
}

const slugOf = (label) => String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Refuse a scenario that cannot give an honest verdict before spending time recording it.
function scenarioErrors() {
  const errors = [];
  const versions = Array.isArray(scenario.versions) ? scenario.versions : [];
  if (versions.length < 1 || versions.length > 2) errors.push('versions must list one or two versions');
  for (const version of versions) {
    if (!version.label || !version.baseUrl) errors.push('every version needs a label and a baseUrl');
    const role = roleOf(version);
    if (role !== null && !ROLES.includes(role)) errors.push(`unknown role "${version.role}" (use before or after)`);
  }
  if (versions.length === 2 && versions.map(roleOf).sort().join() !== 'after,before') {
    errors.push('two versions need one before and one after (label or role)');
  }
  if (new Set(versions.map((v) => slugOf(v.label))).size !== versions.length) errors.push('version labels must differ');
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  steps.forEach((step, i) => {
    if (!ACTIONS[step.action] && !EXPECTATIONS[step.action]) errors.push(`unknown action "${step.action}" in step ${i + 1}`);
  });
  if (!steps.some((step) => EXPECTATIONS[step.action])) errors.push('steps need at least one expect_* check');
  for (const key of ['captions', 'trimWaits', 'full']) {
    if (scenario[key] !== undefined && typeof scenario[key] !== 'boolean') errors.push(`${key} must be true or false`);
  }
  if ([viewport.width, viewport.height].some((n) => !Number.isInteger(n) || n % 2)) {
    errors.push('viewport width and height must be even whole numbers (the video encoder needs even sizes)');
  }
  return errors;
}

const errors = scenarioErrors();
if (errors.length) {
  console.error(`invalid scenario:\n- ${errors.join('\n- ')}`);
  process.exit(2);
}
const font = execFileSync('fc-match', ['-f', '%{file}', 'sans:bold']).toString().trim();
mkdirSync(outDir, { recursive: true });

function srtTime(ms) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(Math.floor(ms % 1000), 3)}`;
}

// Resolves when the page a navigation request opens has loaded, or as soon as it is clear none will:
// the request failed, became a download, or finished without replacing the page (a 204, for one).
function pageLoaded(page, request) {
  return new Promise((resolve) => {
    let current = request;
    let committed = false;
    const listeners = {
      load: () => done(),
      download: () => done(),
      framenavigated: (frame) => { if (frame === page.mainFrame()) committed = true; },
      request: (next) => { if (next.redirectedFrom() === current) current = next; },
      requestfailed: (failed) => { if (failed === current) done(); },
      requestfinished: (finished) => {
        // A redirect finishes too; wait for the request it leads to.
        if (finished === current && !committed && !finished.redirectedTo()) done();
      },
    };
    const timer = setTimeout(() => done(), ACTION_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      Object.entries(listeners).forEach(([event, fn]) => page.off(event, fn));
      resolve();
    }
    Object.entries(listeners).forEach(([event, fn]) => page.on(event, fn));
  });
}

// The middle of a wait is dead footage: mark it to be cut, keeping `edge` ms at each end.
function markIdle(cuts, from, to, edge) {
  if (TRIM && to - from > 2 * edge + 100) cuts.push({ start: from + edge, end: to - edge });
}

// A time on the recording's clock, moved earlier by every cut that comes before it.
const afterCuts = (cuts, t) => t - cuts.reduce((sum, c) => sum + Math.max(0, Math.min(t, c.end) - c.start), 0);

function captionFor(step, index, total, outcome) {
  const prefix = `Step ${index + 1}/${total}: ${step.caption}`;
  if (!outcome) return prefix;
  return `${prefix}\n${outcome.ok ? 'PASS' : 'FAIL'}: ${outcome.note}`;
}

async function recordVersion(browser, version) {
  const slug = slugOf(version.label);
  const rawDir = join(outDir, 'raw', slug);
  mkdirSync(rawDir, { recursive: true });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: rawDir, size: viewport },
    storageState: version.storageState || scenario.storageState,
    ignoreHTTPSErrors: true,
  });
  if (HUMAN) await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  mouse = { x: viewport.width / 2, y: viewport.height / 2 };
  const t0 = Date.now();
  const consoleErrors = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  const now = () => Date.now() - t0;
  // What an action started: a page load (when its request went out, and when the page finished loading),
  // and fetch/XHR traffic such as a Turbo Drive or SPA visit (when it began, what is pending, when it last changed).
  let navigation = null;
  const quietTraffic = () => ({ first: null, pending: new Set(), last: 0 });
  let traffic = quietTraffic();
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) {
      traffic.first ??= now();
      traffic.pending.add(request);
      traffic.last = now();
    }
    if (navigation || !request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    navigation = { start: now(), loaded: pageLoaded(page, request) };
  });
  const finished = (request) => { if (traffic.pending.delete(request)) traffic.last = now(); };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);

  // Waits for the activity an action started, including a request sent just after it returned
  // (an onchange auto-submit, a key press), then cuts that wait, keeping the glide and typing before it.
  async function settle(acted) {
    const returned = now();
    const deadline = returned + TRAFFIC_WAIT_MS;
    while (!navigation && now() < deadline) {
      const idle = traffic.first === null ? now() - returned >= SETTLE_MS
        : traffic.pending.size === 0 && now() - traffic.last >= SETTLE_MS;
      if (idle) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (navigation) await navigation.loaded;
    const started = Math.min(navigation?.start ?? Infinity, traffic.first ?? Infinity);
    if (started !== Infinity) markIdle(cuts, Math.max(started, acted), now(), LOAD_EDGE_MS);
  }

  const cues = [];
  const cuts = [];
  const results = [];
  const steps = scenario.steps;
  let aborted = false;

  for (const [i, step] of steps.entries()) {
    const start = Date.now() - t0;
    // Caption appears first, then a beat to "read" it before acting, like a person would. A blank first page has nothing to read.
    if (page.url() !== 'about:blank') await pause(page, ...READ_PAUSE_MS);
    const kind = EXPECTATIONS[step.action] ? 'check' : 'action';
    let outcome = null;
    if (aborted) {
      outcome = { ok: false, skipped: true, note: 'skipped, an earlier step could not run' };
    } else if (kind === 'check') {
      const from = now();
      try {
        await EXPECTATIONS[step.action](page, step);
        outcome = { ok: true, note: step.pass || 'as expected', waitedMs: now() - from };
      } catch (err) {
        // The wait is cut from the video, so the caption keeps the real time spent waiting.
        const waitedMs = now() - from;
        const note = `${step.fail || err.message.split('\n')[0]} (waited ${(waitedMs / 1000).toFixed(1)}s)`;
        outcome = { ok: false, note, waitedMs };
      }
      markIdle(cuts, from, now(), CHECK_EDGE_MS);
    } else {
      // A missing selector should fail in seconds, not record 30s of a frozen page.
      page.setDefaultTimeout(step.timeoutMs ?? (step.action === 'goto' ? NAVIGATION_TIMEOUT_MS : ACTION_TIMEOUT_MS));
      const from = now();
      navigation = null;
      traffic = quietTraffic();
      const acted = { at: Date.now() };
      try {
        await ACTIONS[step.action](page, step, version.baseUrl, acted);
        if (step.action === 'goto' || step.action === 'wait_for') {
          markIdle(cuts, from, now(), LOAD_EDGE_MS);
        } else if (step.action !== 'wait') {
          await settle(acted.at - t0);
        }
      } catch (err) {
        outcome = { ok: false, note: `could not ${step.action}: ${err.message.split('\n')[0]}` };
        aborted = true;
      }
    }
    await page.waitForTimeout(step.holdMs ?? (outcome ? HOLD_MS.check : HOLD_MS.action));
    cues.push({ start, end: now(), text: captionFor(step, i, steps.length, outcome) });
    results.push({ step: i + 1, caption: step.caption, action: step.action, kind, ...(outcome || { ok: true, note: 'done' }) });
  }

  // The page alone; the caption strip is added to it with the video.
  // Edge markers along the bottom and right of the viewport prove the page fills the video frame
  // (frameCheck). They are hit-tested invisible first: a page that covers an edge (a modal backdrop, a
  // transformed root) skips the check instead of failing it. burnCaptions trims the clip before them.
  const covered = await page.evaluate(({ css, size }) => new Promise((resolve) => {
    const edges = [`left:0;bottom:0;width:100vw;height:${size}px`, `top:0;right:0;height:100vh;width:${size}px`].map((box) => {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;${box};background:${css};opacity:0;z-index:2147483647`;
      return document.documentElement.appendChild(el);
    });
    const [bottom, right] = edges;
    // clientWidth and clientHeight leave out scrollbars, so the probe never lands on one.
    const { clientWidth: width, clientHeight: height } = document.documentElement;
    const reached = document.elementFromPoint(width / 2, height - 2) === bottom
      && document.elementFromPoint(width - 2, height / 2) === right;
    if (!reached) {
      edges.forEach((el) => el.remove());
      resolve(true);
      return;
    }
    edges.forEach((el) => { el.style.opacity = '1'; });
    setTimeout(() => { edges.forEach((el) => el.remove()); resolve(false); }, 300);
  }), EDGE_MARKER).catch((err) => err.message.split('\n')[0]);
  // Headless Chrome sends video frames only when the page repaints, so a static page can leave the
  // recording empty ("Page did not produce any video frames"). Toggle a 1px overlay to force a repaint.
  await page.evaluate(() => new Promise((resolve) => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;background:rgba(0,0,0,0.01);pointer-events:none;z-index:2147483647';
    document.documentElement.appendChild(dot);
    requestAnimationFrame(() => requestAnimationFrame(() => { dot.remove(); requestAnimationFrame(resolve); }));
  })).catch(() => {});
  const pageShot = join(rawDir, `${slug}-final-page.png`);
  await page.screenshot({ path: pageShot, fullPage: false });
  const video = page.video();
  await context.close();
  const webm = join(rawDir, `${slug}.webm`);
  renameSync(await video.path(), webm);

  const shifted = cues.map((c) => ({ ...c, start: afterCuts(cuts, c.start), end: afterCuts(cuts, c.end) }));
  writeFileSync(join(outDir, `${slug}.srt`), shifted
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));

  const trimmedMs = Math.round(cuts.reduce((sum, c) => sum + c.end - c.start, 0));
  return { ...version, slug, webm, cues: shifted, cuts, trimmedMs, results, aborted, consoleErrors, pageShot,
    frameCheck: covered === true ? { ok: true, skipped: 'the page covers the viewport edges' }
      : covered ? { ok: false, note: `frame check could not run: ${covered}` } : frameCheck(webm), screenshot: join(outDir, `${slug}-final.png`) };
}

// Some browsers draw the page into only part of the video frame and fill the rest with grey (installed
// Chrome's headless mode on macOS did). Finds the first raw frame whose bottom and right edges both show
// the markers; markerAt is its time in the raw video, where the clip must end.
function frameCheck(webm) {
  const inset = EDGE_MARKER.size / 2;
  // Both edge strips side by side, so one frame's chroma minimum says whether every pixel is magenta.
  const strips = `scale=${viewport.width}:${viewport.height},split[a][b];[a]crop=iw:2:0:ih-${inset}[bottom];`
    + `[b]crop=2:ih:iw-${inset}:0,transpose=1[right];[bottom][right]hstack,signalstats,metadata=mode=print:file=-`;
  let log;
  try {
    log = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', webm, '-filter_complex', strips, '-f', 'null', '-'],
      { maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (err) {
    return { ok: false, note: `frame check could not read the recording: ${err.message.split('\n')[0]}` };
  }
  for (const entry of log.split(/(?=^frame:)/m)) {
    const value = (key) => Number(entry.match(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`))?.[1]);
    if (value('UMIN') > 180 && value('VMIN') > 180) {
      return { ok: true, markerAt: Number(entry.match(/pts_time:([\d.]+)/)[1]) };
    }
  }
  return { ok: false, note: 'page did not fill the video frame (the edge markers never reached its bottom and right)' };
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: outDir, stdio: 'inherit' });
}

function textFile(name, text) {
  writeFileSync(join(outDir, name), text);
  return name;
}

// drawtext reads % as an expansion; expansion=none prints user text exactly as written.
const drawText = (file, options) => `drawtext=fontfile='${font}':textfile=${file}:expansion=none:fontcolor=white:${options}`;

// Tall enough for the longest caption once wrapped (at least two lines), so every clip and card share one size.
function stripHeightFor(texts) {
  const perLine = Math.floor((viewport.width - 2 * CAPTION_MARGIN) / (CAPTION_PX * 0.5));
  const lines = Math.max(2, ...texts.map((text) => text.split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0)));
  // libx264 needs an even frame height.
  const height = Math.ceil(lines * CAPTION_PX * 1.2 + CAPTION_PX);
  return height + ((viewport.height + height) % 2);
}

// Dark strip with the captions centred in it. force_style reads Alignment as legacy SSA, where 10 is middle centre.
function captionStrip(srt) {
  const style = `PlayResX=${viewport.width},PlayResY=${stripHeight},FontName=Noto Sans,FontSize=${CAPTION_PX},Bold=1,`
    + `PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=0,Shadow=0,Alignment=10,`
    + `MarginL=${CAPTION_MARGIN},MarginR=${CAPTION_MARGIN},MarginV=0`;
  return `color=c=${STRIP_COLOUR}:s=${viewport.width}x${stripHeight}:r=${FPS},subtitles=${srt}:force_style='${style}'`;
}

// Page filters, then the caption strip stacked below the page; with captions off, the page filters alone.
const withStrip = (pageFilters, srt, tail) => (CAPTIONS ? ['-filter_complex',
  `[0:v]${pageFilters}[page];${captionStrip(srt)}[strip];[page][strip]vstack=inputs=2:shortest=1${tail}[v]`, '-map', '[v]']
  : ['-vf', `${pageFilters}${tail}`]);

// Drops the cut waits from the footage and closes the gaps, matching the shifted caption times.
function cutFilter(cuts) {
  if (!cuts.length) return '';
  const spans = cuts.map((c) => `between(t,${(c.start / 1000).toFixed(3)},${(c.end / 1000).toFixed(3)})`).join('+');
  return `,select='not(${spans})',setpts=N/FRAME_RATE/TB`;
}

// The clean clip, its contact sheet and last frame; with --full, also the clip with a banner strip
// above the page naming the version. Step captions sit in the strip below the page.
function burnCaptions(rec) {
  const banner = textFile(`${rec.slug}-banner.txt`, `${rec.label}${rec.detail ? `  ·  ${rec.detail}` : ''}`);
  const colour = rec.role === 'before' ? '0xB42318' : '0x067647';
  const srt = `${rec.slug}.srt`;
  const tail = ',format=yuv420p,setsar=1';
  const scale = `scale=${viewport.width}:${viewport.height}`;
  // The screencast sends no frames while the page is still, so repeat the last one and end the clip with the last caption.
  // The clip ends before the frame check's edge markers; the clock of the raw video can lead the cue times.
  const beforeMarkers = rec.frameCheck.markerAt ? `trim=end=${rec.frameCheck.markerAt.toFixed(3)},` : '';
  const page = `${beforeMarkers}${scale},fps=${FPS}${cutFilter(rec.cuts)},tpad=stop_mode=clone:stop_duration=1`;
  const length = ['-t', String(Math.ceil(((rec.cues.at(-1)?.end ?? 0) / 1000) * FPS) / FPS)];
  const bannerStrip = `pad=${viewport.width}:${viewport.height + BANNER_HEIGHT}:0:${BANNER_HEIGHT}:color=${colour},`
    + drawText(banner, 'fontsize=26:x=24:y=15');
  const out = `${rec.slug}.mp4`;
  if (FULL) {
    ffmpeg(['-i', rec.webm, ...withStrip(`${page},${bannerStrip}`, srt, tail), '-an', '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '22', ...length, out]);
  }
  // The footage and captions with no version banner or cards, to share on its own.
  ffmpeg(['-i', rec.webm, ...withStrip(page, srt, tail), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', ...length,
    '-movflags', '+faststart', cleanName(rec)]);
  // The last frame keeps the banner and shows the last caption in the strip.
  const last = rec.cues.at(-1);
  const lastSrt = textFile(`${rec.slug}-final.srt`, `1\n${srtTime(0)} --> ${srtTime(3600000)}\n${last ? last.text : ''}\n`);
  ffmpeg(['-loop', '1', '-i', rec.pageShot, ...withStrip(`${scale},${bannerStrip}`, lastSrt, ''), '-frames:v', '1', rec.screenshot]);
  contactSheet(cleanName(rec), `${rec.slug}-sheet.png`);
  return FULL ? out : null;
}

// <id>-before.mp4 and <id>-after.mp4; a version without a role keeps its slug.
const cleanName = (rec) => `${scenario.id || 'video-qa'}-${rec.role || rec.slug}.mp4`;

// Twelve frames spread evenly over the whole clip, so a reviewer sees the trigger and the result.
function contactSheet(clip, sheet) {
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', join(outDir, clip)]).toString().trim());
  ffmpeg(['-i', clip, '-vf', `fps=${(12 / seconds).toFixed(4)},scale=640:-1,tile=4x3`, '-frames:v', '1', sheet]);
}

function card(name, lines) {
  const file = textFile(`${name}.txt`, lines.join('\n'));
  const out = `${name}.mp4`;
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=0x14233B:s=${frame.width}x${frame.height}:d=${CARD_SECONDS}:r=${FPS}`,
    '-vf', `${drawText(file, 'fontsize=34:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2')},format=yuv420p,setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', out,
  ]);
  return out;
}

// A fix is proven only when a check fails on BEFORE and every step passes on AFTER. An action
// that could not run (server down, selector missing) or a page that did not fill the video proves
// nothing, so the run is INCOMPLETE.
function verdict(recs) {
  if (recs.some((r) => r.aborted || !r.frameCheck.ok)) return 'INCOMPLETE';
  const checkFailed = (rec) => rec.results.some((r) => r.kind === 'check' && !r.ok);
  if (recs.length === 1) return checkFailed(recs[0]) ? 'FAILING' : 'WORKING';
  if (checkFailed(recs.find((r) => r.role === 'after'))) return 'STILL BROKEN';
  return checkFailed(recs.find((r) => r.role === 'before')) ? 'FIXED' : 'NOT REPRODUCED ON BEFORE';
}

function summaryLine(rec) {
  const stopped = rec.results.find((r) => r.kind === 'action' && !r.ok && !r.skipped);
  if (stopped) return `${rec.label}: stopped at step ${stopped.step}, could not ${stopped.action}`;
  if (!rec.frameCheck.ok) return `${rec.label}: ${rec.frameCheck.note}`;
  const checks = rec.results.filter((r) => r.kind === 'check');
  const failed = checks.filter((r) => !r.ok);
  if (failed.length === 0) return `${rec.label}: all ${checks.length} checks passed`;
  return `${rec.label}: ${failed.length} of ${checks.length} checks failed (${failed.map((r) => `step ${r.step}`).join(', ')})`;
}

const browser = await chromium.launch({
  // Playwright's Chromium by default; VIDEO_QA_CHANNEL=chrome uses installed Chrome, whose headless
  // mode on macOS drew the page into only part of the video frame.
  channel: process.env.VIDEO_QA_CHANNEL || 'chromium',
  headless: process.env.VIDEO_QA_HEADED !== '1',
  // Human pacing sets its own timing; a per-call delay on top made every glide and keystroke crawl.
  slowMo: scenario.slowMo ?? (scenario.pace === 'fast' ? 200 : 0),
});
const recordings = [];
try {
  for (const version of scenario.versions) {
    recordings.push({ ...(await recordVersion(browser, version)), role: roleOf(version) });
  }
} finally {
  await browser.close();
}
stripHeight = CAPTIONS ? stripHeightFor(recordings.flatMap((rec) => rec.cues.map((cue) => cue.text))) : 0;
frame.height = viewport.height + BANNER_HEIGHT + stripHeight;

const outcome = verdict(recordings);
const finalName = `${scenario.id || 'video-qa'}.mp4`;
const clips = recordings.map(burnCaptions);
if (FULL) {
  const segments = [card('title', [scenario.title, '', ...(scenario.subtitle ? [scenario.subtitle] : []),
    ...recordings.map((r) => `${r.label}: ${r.detail || r.baseUrl}`)])];
  recordings.forEach((rec, i) => segments.push(card(`${rec.slug}-card`, [rec.label, rec.detail || rec.baseUrl]), clips[i]));
  segments.push(card('summary', [`Verdict: ${outcome}`, '', ...recordings.map(summaryLine)]));
  const list = textFile('segments.txt', segments.map((s) => `file '${s}'`).join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', finalName]);

  if (recordings.length === 2 && scenario.sideBySide !== false) {
    ffmpeg(['-i', clips[0], '-i', clips[1], '-filter_complex',
      '[0:v][1:v]hstack=inputs=2:shortest=0,scale=1920:-2,format=yuv420p[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', 'side-by-side.mp4']);
  }
}

const report = {
  title: scenario.title,
  verdict: outcome,
  automated: true,
  captions: CAPTIONS,
  video: FULL ? join(outDir, finalName) : null,
  sideBySide: FULL && existsSync(join(outDir, 'side-by-side.mp4')) ? join(outDir, 'side-by-side.mp4') : null,
  versions: recordings.map(({ label, detail, baseUrl, role, slug, results, aborted, frameCheck, consoleErrors, screenshot, trimmedMs }) => ({
    label, detail, baseUrl, role, trimmedMs, clip: FULL ? join(outDir, `${slug}.mp4`) : null,
    cleanClip: join(outDir, cleanName({ role, slug })), captions: join(outDir, `${slug}.srt`),
    sheet: join(outDir, `${slug}-sheet.png`), screenshot, aborted, frameCheck, results, consoleErrors,
  })),
};
writeFileSync(join(outDir, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: outcome, video: report.video, sideBySide: report.sideBySide,
  cleanClips: report.versions.map((v) => v.cleanClip),
  sheets: report.versions.map((v) => v.sheet),
  summary: recordings.map(summaryLine) }, null, 2));
const EXIT_CODES = { FIXED: 0, WORKING: 0, INCOMPLETE: 2 };
process.exitCode = EXIT_CODES[outcome] ?? 1;
