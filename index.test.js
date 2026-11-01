const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { summarize } = require('./index.js');

const run = promisify(execFile);
const gib = 1024 * 1024;

test('reports a transient peak rather than just the final disk usage', () => {
  const result = summarize([
    { time: 'start', total: 100 * gib, used: 40 * gib, available: 60 * gib },
    { time: 'peak', total: 100 * gib, used: 75 * gib, available: 25 * gib },
    { time: 'end', total: 100 * gib, used: 50 * gib, available: 50 * gib },
  ]);
  assert.match(result, /Peak observed used space \| 75\.00/);
  assert.match(result, /Minimum observed free space \| 25\.00/);
  assert.match(result, /Maximum net drop in free space from start \| 35\.00/);
  assert.match(result, /Lowest free space observed at peak/);
});

test('cleanup does not produce a negative free-space drop or erase an earlier peak', () => {
  const result = summarize([
    { time: 'start', total: 100 * gib, used: 60 * gib, available: 40 * gib },
    { time: 'cleaned', total: 100 * gib, used: 35 * gib, available: 65 * gib },
    { time: 'end', total: 100 * gib, used: 50 * gib, available: 50 * gib },
  ]);
  assert.match(result, /Peak observed used space \| 60\.00/);
  assert.match(result, /Minimum observed free space \| 40\.00/);
  assert.match(result, /Maximum net drop in free space from start \| 0\.00/);
});

for (const missingWorkspace of [false, true]) {
  test(missingWorkspace ? 'surfaces sampling errors instead of reporting success' : 'sampler survives the main action and stops in the post action', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-usage-test-'));
    const state = path.join(temporary, 'state');
    const summary = path.join(temporary, 'summary');
    const env = {
      ...process.env,
      RUNNER_TEMP: temporary,
      GITHUB_WORKSPACE: missingWorkspace ? path.join(temporary, 'missing') : temporary,
      GITHUB_STATE: state,
      GITHUB_STEP_SUMMARY: summary,
    };
    let directory;
    try {
      const main = run(process.execPath, [path.join(__dirname, 'index.js')], { env, timeout: 15000 });
      if (missingWorkspace) {
        await assert.rejects(main, error => error.code === 1 && error.stderr.includes('Disk usage monitoring failed'));
      } else {
        await main;
      }
      directory = fs.readFileSync(state, 'utf8').trim().split('=')[1];
      if (!missingWorkspace) {
        assert.ok(fs.existsSync(path.join(directory, 'samples.jsonl')));
        const sampleCount = () => fs.readFileSync(path.join(directory, 'samples.jsonl'), 'utf8').trim().split('\n').length;
        for (let attempt = 0; attempt < 100 && sampleCount() < 2; attempt++) {
          await delay(100);
        }
        assert.ok(sampleCount() >= 2, 'sampling must continue after the main action exits');
        assert.equal(fs.existsSync(path.join(directory, 'stopped')), false);
      }
      const post = run(process.execPath, [path.join(__dirname, 'post.js')], {
        env: { ...env, STATE_disk_usage_dir: directory },
        timeout: 15000,
      });
      if (missingWorkspace) {
        await assert.rejects(post, error => error.code === 1 && error.stderr.includes('Disk usage monitoring failed'));
        assert.equal(fs.existsSync(summary), false);
      } else {
        const { stdout } = await post;
        assert.match(stdout, /Disk usage samples/);
        assert.match(fs.readFileSync(summary, 'utf8'), /Peak observed used space/);
        assert.ok(fs.readFileSync(path.join(directory, 'samples.jsonl'), 'utf8').trim().split('\n').length >= 3);
      }
      assert.ok(fs.existsSync(path.join(directory, 'stopped')));
    } finally {
      if (!directory && fs.existsSync(state)) {
        directory = fs.readFileSync(state, 'utf8').trim().split('=')[1];
      }
      if (directory && !fs.existsSync(path.join(directory, 'stopped'))) {
        fs.writeFileSync(path.join(directory, 'stop'), '');
        for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(directory, 'stopped')); attempt++) {
          await delay(100);
        }
        assert.ok(fs.existsSync(path.join(directory, 'stopped')), 'sampler must stop before deleting its files');
      }
      fs.rmSync(temporary, { recursive: true });
    }
  });
}
