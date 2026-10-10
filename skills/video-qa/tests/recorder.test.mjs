// End-to-end checks for scripts/record.mjs: real Chrome, real ffmpeg, tiny local pages.
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
const missing = [
  !existsSync(join(scripts, 'node_modules', 'playwright-core')) && 'scripts/node_modules (npm install)',
  !existsSync('/usr/bin/google-chrome') && !process.env.VIDEO_QA_CHANNEL && 'Chrome',
  ...['ffmpeg', 'ffprobe', 'fc-match'].filter((bin) => !onPath(bin)),
].filter(Boolean);
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

function serve(html) {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end(html));
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

function record(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'video-qa-test-'));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(spec));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [recorder, join(dir, 'scenario.json'), dir]);
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

const frameHeight = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=height', '-of', 'csv=p=0', file]).toString().trim());

test('a check failing on BEFORE and passing on AFTER is FIXED, with % titles and the banner above the page', { skip }, async () => {
  const run = await withServers([page({ fixed: false }), page({ fixed: true })],
    ([before, after]) => record(scenario('Discount shows 20% off', before, after)));
  try {
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.results.verdict, 'FIXED');
    assert.doesNotMatch(run.stderr, /Stray %/);
    assert.equal(frameHeight(join(run.dir, 'before.mp4')), VIEWPORT.height + BANNER_HEIGHT);
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
