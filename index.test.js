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

test('includes a Mermaid XY chart with used and available space in GiB', () => {
  const result = summarize([
    { time: 'start', total: 100 * gib, used: 40 * gib, available: 60 * gib },
    { time: 'peak', total: 100 * gib, used: 75 * gib, available: 25 * gib },
    { time: 'end', total: 100 * gib, used: 50 * gib, available: 50 * gib },
  ]);
  assert.ok(result.includes([
    'xychart',
    '    title "Workspace filesystem usage"',
    '    x-axis "Sample number (5-second sampling)" 1 --> 3',
    '    y-axis "GiB" 0 --> 100',
    '    line [40.00, 75.00, 50.00]',
    '    line [60.00, 25.00, 50.00]',
    '```',
  ].join('\n')));
  assert.match(result, /```mermaid\n---\nconfig:\n  themeVariables:\n    xyChart:\n      plotColorPalette: "#3b82f6, #d97706"\n---\n/);
  assert.match(result, /\*\*Blue line:\*\* used space\. \*\*Orange line:\*\* available space\./);
  assert.match(result, /Sampling includes a final post-job sample/);
  assert.doesNotMatch(result, /chart groups/);
});

test('renders a single sample as labeled bars without a zero-width numeric axis', () => {
  const result = summarize([
    { time: 'only', total: 0.5 * gib, used: 0.125 * gib, available: 0.375 * gib },
  ]);
  assert.match(result, /x-axis "Space" \["Used", "Available"\]/);
  assert.match(result, /y-axis "GiB" 0 --> 1/);
  assert.match(result, /bar \[0\.13, 0\.38\]/);
  assert.match(result, /Only one sample was recorded/);
  assert.doesNotMatch(result, /    line|Blue line|Orange line/);
  assert.doesNotMatch(result, /NaN|Infinity/);
});

test('scales the chart to the largest observed filesystem capacity', () => {
  const result = summarize([
    { time: 'start', total: 100 * gib, used: 40 * gib, available: 60 * gib },
    { time: 'resized', total: 150.25 * gib, used: 110 * gib, available: 40.25 * gib },
  ]);
  assert.match(result, /y-axis "GiB" 0 --> 151/);
  assert.match(result, /Filesystem capacity \| 100\.00/);
});

for (const count of [60, 61, 4321, 120961]) {
  test(`bounds a ${count}-sample chart while preserving every window's extremes`, () => {
    const samples = Array.from({ length: count }, (_, index) => ({
      time: `sample-${index}`,
      total: 100 * gib,
      used: 40 * gib,
      available: 60 * gib,
    }));
    samples[0].used = 10 * gib;
    samples[0].available = 90 * gib;
    samples[17].used = 95 * gib;
    samples[23].available = 2 * gib;
    samples[count - 1].used = 45 * gib;
    samples[count - 1].available = 55 * gib;
    const result = summarize(samples);
    const lines = [...result.matchAll(/    line \[([^\]]+)\]/g)];
    assert.equal(lines.length, 2);
    const used = lines[0][1].split(', ').map(Number);
    const available = lines[1][1].split(', ').map(Number);
    assert.equal(used.length, 60);
    assert.equal(available.length, 60);
    for (let point = 0; point < 60; point++) {
      const start = Math.max(0, Math.ceil((point - 0.5) * (count - 1) / 59));
      const end = point === 59 ? count : Math.ceil((point + 0.5) * (count - 1) / 59);
      const window = samples.slice(start, end);
      assert.equal(used[point], Math.max(...window.map(entry => entry.used / gib)));
      assert.equal(available[point], Math.min(...window.map(entry => entry.available / gib)));
    }
    assert.equal(Math.max(...used), 95);
    assert.equal(Math.min(...available), 2);
    assert.match(result, /Peak observed used space \| 95\.00/);
    assert.match(result, /Minimum observed free space \| 2\.00/);
    assert.match(result, /Maximum net drop in free space from start \| 88\.00/);
    assert.match(result, /Lowest free space observed at sample-23/);
    assert.ok(Buffer.byteLength(result) < 5000, 'even a week-long job should produce a small summary');
    assert.doesNotMatch(result, /NaN|Infinity/);
    if (count > 60) {
      assert.match(result, new RegExp(`chart groups ${count} samples into 60 evenly spaced sample windows`));
    } else {
      assert.doesNotMatch(result, /chart groups/);
    }
  });
}

test('rejects an empty sample set', () => {
  assert.throws(() => summarize([]), /No disk usage samples were recorded/);
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
        const result = fs.readFileSync(summary, 'utf8');
        assert.match(result, /Peak observed used space/);
        assert.match(result, /
        assert.equal([...result.matchAll(/    line \[\d/g)].length, 2);
        assert.ok(stdout.includes(result));
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
