#!/usr/bin/env node
// Records one captioned video per version of a scenario, then joins them into
// a single before/after film with title cards. See ../SKILL.md for the format.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const STEP_HOLD_MS = 1400;
const EXPECT_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 10000;
const NAVIGATION_TIMEOUT_MS = 30000;
const BANNER_HEIGHT = 56;
const CARD_SECONDS = 3;
const FPS = 25;

const [scenarioPath, outArg] = process.argv.slice(2);
if (!scenarioPath) {
  console.error('usage: record.mjs <scenario.json> [output-dir]');
  process.exit(2);
}

const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const outDir = resolve(outArg || join(dirname(resolve(scenarioPath)), 'video'));
const viewport = scenario.viewport || { width: 1280, height: 800 };
// The banner gets its own strip above the page, so it never hides the top of the page.
const frame = { width: viewport.width, height: viewport.height + BANNER_HEIGHT };

// Human pacing: a visible cursor glides to each target, typing has an uneven rhythm,
// and there is a short varied pause before every action. "pace": "fast" turns it off.
const HUMAN = scenario.pace !== 'fast';
const jitter = (min, max) => min + Math.random() * (max - min);
const pause = (page, min, max) => (HUMAN ? page.waitForTimeout(jitter(min, max)) : null);

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
async function moveTo(page, selector) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  if (!HUMAN) return target;
  const box = await target.boundingBox();
  if (box) {
    const x = box.x + box.width * jitter(0.35, 0.65);
    const y = box.y + box.height * jitter(0.35, 0.65);
    const distance = Math.hypot(x - mouse.x, y - mouse.y);
    await page.mouse.move(x, y, { steps: Math.max(8, Math.round(distance / 18)) });
    mouse = { x, y };
    await pause(page, 150, 400);
  }
  return target;
}

async function humanType(page, selector, value, clear) {
  const target = await moveTo(page, selector);
  await target.click();
  // fill starts empty; type appends, so put the caret after the existing text.
  if (clear) await target.fill('');
  else await target.press('End');
  if (!HUMAN) return page.keyboard.type(value);
  for (const ch of value) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(ch === ' ' || ch === '@' ? jitter(120, 260) : jitter(45, 140));
  }
}

const ACTIONS = {
  goto: (page, s, base) => page.goto(new URL(s.url, base).href, { waitUntil: 'networkidle' }),
  click: async (page, s) => (await moveTo(page, s.selector)).click(),
  fill: (page, s) => humanType(page, s.selector, String(s.value ?? ''), true),
  type: (page, s) => humanType(page, s.selector, String(s.value ?? ''), false),
  press: (page, s) => page.keyboard.press(s.key),
  select: async (page, s) => (await moveTo(page, s.selector)).selectOption(s.value),
  hover: (page, s) => moveTo(page, s.selector),
  check: async (page, s) => (await moveTo(page, s.selector)).check(),
  wait: (page, s) => page.waitForTimeout(s.ms ?? 1000),
  wait_for: (page, s) => page.locator(s.selector).first().waitFor(),
  scroll: (page, s) => moveTo(page, s.selector),
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

  const cues = [];
  const results = [];
  const steps = scenario.steps;
  let aborted = false;

  for (const [i, step] of steps.entries()) {
    const start = Date.now() - t0;
    // Caption appears first, then a beat to "read" it before acting, like a person would.
    await pause(page, 500, 1100);
    const kind = EXPECTATIONS[step.action] ? 'check' : 'action';
    let outcome = null;
    if (aborted) {
      outcome = { ok: false, skipped: true, note: 'skipped, an earlier step could not run' };
    } else if (kind === 'check') {
      try {
        await EXPECTATIONS[step.action](page, step);
        outcome = { ok: true, note: step.pass || 'as expected' };
      } catch (err) {
        outcome = { ok: false, note: step.fail || err.message.split('\n')[0] };
      }
    } else {
      // A missing selector should fail in seconds, not record 30s of a frozen page.
      page.setDefaultTimeout(step.timeoutMs ?? (step.action === 'goto' ? NAVIGATION_TIMEOUT_MS : ACTION_TIMEOUT_MS));
      try {
        await ACTIONS[step.action](page, step, version.baseUrl);
      } catch (err) {
        outcome = { ok: false, note: `could not ${step.action}: ${err.message.split('\n')[0]}` };
        aborted = true;
      }
    }
    await page.waitForTimeout(step.holdMs ?? (outcome ? STEP_HOLD_MS * 1.5 : STEP_HOLD_MS));
    cues.push({ start, end: Date.now() - t0, text: captionFor(step, i, steps.length, outcome) });
    results.push({ step: i + 1, caption: step.caption, action: step.action, kind, ...(outcome || { ok: true, note: 'done' }) });
  }

  const shot = join(outDir, `${slug}-final.png`);
  await page.screenshot({ path: shot, fullPage: false });
  const video = page.video();
  await context.close();
  const webm = join(rawDir, `${slug}.webm`);
  renameSync(await video.path(), webm);

  writeFileSync(join(outDir, `${slug}.srt`), cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));

  return { ...version, slug, webm, results, aborted, consoleErrors, screenshot: shot };
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: outDir, stdio: 'inherit' });
}

function textFile(name, text) {
  writeFileSync(join(outDir, name), text);
  return name;
}

// drawtext reads % as an expansion; expansion=none prints user text exactly as written.
const drawText = (file, options) => `drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontcolor=white:${options}`;

// Banner strip above the page naming the version, plus burned-in step captions.
function burnCaptions(rec) {
  const banner = textFile(`${rec.slug}-banner.txt`, `${rec.label}${rec.detail ? `  ·  ${rec.detail}` : ''}`);
  const colour = rec.role === 'before' ? '0xB42318' : '0x067647';
  // BorderStyle=4 draws one box behind a multi-line caption (libass 0.17+).
  const style = 'FontName=Noto Sans,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,BorderStyle=4,'
    + 'OutlineColour=&HFF000000,BackColour=&H40000000,Outline=10,Shadow=0,MarginV=28';
  const filters = [
    `scale=${viewport.width}:${viewport.height}`,
    `pad=${frame.width}:${frame.height}:0:${BANNER_HEIGHT}:color=${colour}`,
    drawText(banner, 'fontsize=26:x=24:y=15'),
    `subtitles=${rec.slug}.srt:force_style='${style}'`,
    `fps=${FPS}`, 'format=yuv420p', 'setsar=1',
  ].join(',');
  const out = `${rec.slug}.mp4`;
  ffmpeg(['-i', rec.webm, '-vf', filters, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', out]);
  contactSheet(out, `${rec.slug}-sheet.png`);
  return out;
}

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
// that could not run (server down, selector missing) proves nothing, so the run is INCOMPLETE.
function verdict(recs) {
  if (recs.some((r) => r.aborted)) return 'INCOMPLETE';
  const checkFailed = (rec) => rec.results.some((r) => r.kind === 'check' && !r.ok);
  if (recs.length === 1) return checkFailed(recs[0]) ? 'FAILING' : 'WORKING';
  if (checkFailed(recs.find((r) => r.role === 'after'))) return 'STILL BROKEN';
  return checkFailed(recs.find((r) => r.role === 'before')) ? 'FIXED' : 'NOT REPRODUCED ON BEFORE';
}

function summaryLine(rec) {
  const stopped = rec.results.find((r) => r.kind === 'action' && !r.ok && !r.skipped);
  if (stopped) return `${rec.label}: stopped at step ${stopped.step}, could not ${stopped.action}`;
  const checks = rec.results.filter((r) => r.kind === 'check');
  const failed = checks.filter((r) => !r.ok);
  if (failed.length === 0) return `${rec.label}: all ${checks.length} checks passed`;
  return `${rec.label}: ${failed.length} of ${checks.length} checks failed (${failed.map((r) => `step ${r.step}`).join(', ')})`;
}

const browser = await chromium.launch({
  // Prefer installed Chrome; VIDEO_QA_CHANNEL overrides (e.g. "chromium" after `playwright install chromium`).
  channel: process.env.VIDEO_QA_CHANNEL || (existsSync('/usr/bin/google-chrome') ? 'chrome' : 'chromium'),
  headless: process.env.VIDEO_QA_HEADED !== '1',
  slowMo: scenario.slowMo ?? (scenario.pace === 'fast' ? 200 : 60),
});
const recordings = [];
try {
  for (const version of scenario.versions) {
    recordings.push({ ...(await recordVersion(browser, version)), role: roleOf(version) });
  }
} finally {
  await browser.close();
}

const segments = [card('title', [scenario.title, '', ...(scenario.subtitle ? [scenario.subtitle] : []),
  ...recordings.map((r) => `${r.label}: ${r.detail || r.baseUrl}`)])];
for (const rec of recordings) {
  segments.push(card(`${rec.slug}-card`, [rec.label, rec.detail || rec.baseUrl]));
  segments.push(burnCaptions(rec));
}
const outcome = verdict(recordings);
segments.push(card('summary', [`Verdict: ${outcome}`, '', ...recordings.map(summaryLine)]));

const list = textFile('segments.txt', segments.map((s) => `file '${s}'`).join('\n'));
const finalName = `${scenario.id || 'video-qa'}.mp4`;
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', finalName]);

if (recordings.length === 2 && scenario.sideBySide !== false) {
  const [a, b] = recordings.map((r) => `${r.slug}.mp4`);
  ffmpeg(['-i', a, '-i', b, '-filter_complex',
    '[0:v][1:v]hstack=inputs=2:shortest=0,scale=1920:-2,format=yuv420p[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', 'side-by-side.mp4']);
}

const report = {
  title: scenario.title,
  verdict: outcome,
  automated: true,
  video: join(outDir, finalName),
  sideBySide: existsSync(join(outDir, 'side-by-side.mp4')) ? join(outDir, 'side-by-side.mp4') : null,
  versions: recordings.map(({ label, detail, baseUrl, role, slug, results, aborted, consoleErrors, screenshot }) => ({
    label, detail, baseUrl, role, clip: join(outDir, `${slug}.mp4`), captions: join(outDir, `${slug}.srt`),
    sheet: join(outDir, `${slug}-sheet.png`), screenshot, aborted, results, consoleErrors,
  })),
};
writeFileSync(join(outDir, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: outcome, video: report.video, sideBySide: report.sideBySide,
  sheets: report.versions.map((v) => v.sheet),
  summary: recordings.map(summaryLine) }, null, 2));
const EXIT_CODES = { FIXED: 0, WORKING: 0, INCOMPLETE: 2 };
process.exitCode = EXIT_CODES[outcome] ?? 1;
