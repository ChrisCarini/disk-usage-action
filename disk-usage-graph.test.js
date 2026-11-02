const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const run = promisify(execFile);
const kibPerGib = 1024 * 1024;
const allocationBytes = 2 * 1024 * 1024 * 1024;

test('charts real disk usage rising and falling over 30 seconds', { timeout: 90000 }, async t => {
  const workspace = process.env.GITHUB_WORKSPACE || __dirname;
  const filesystem = fs.statfsSync(workspace);
  assert.ok(filesystem.bavail * filesystem.bsize >= 3 * allocationBytes,
    'The graph test requires at least 6 GiB free: 4 GiB for files and 2 GiB of headroom.');

  const temporary = fs.mkdtempSync(path.join(workspace, '.disk-usage-graph-test-'));
  const state = path.join(temporary, 'state');
  const summary = path.join(temporary, 'summary');
  const files = [path.join(temporary, 'first.bin'), path.join(temporary, 'second.bin')];
  const phases = [
    { allocated: 0 },
    { allocated: 2, create: files[0] },
    { allocated: 4, create: files[1] },
    { allocated: 2, remove: files[1] },
    { allocated: 0, remove: files[0] },
  ];
  const env = {
    ...process.env,
    RUNNER_TEMP: temporary,
    GITHUB_WORKSPACE: workspace,
    GITHUB_STATE: state,
    GITHUB_STEP_SUMMARY: summary,
  };
  let directory;
  try {
    await run(process.execPath, [path.join(__dirname, 'index.js')], { env, timeout: 15000, signal: t.signal });
    directory = fs.readFileSync(state, 'utf8').match(/^disk_usage_dir=(.+)$/m)?.[1];
    assert.ok(directory, 'The main action must save its sampler directory.');

    for (const phase of phases) {
      if (phase.create) {
        await run('fallocate', ['--length', String(allocationBytes), phase.create], { timeout: 15000, signal: t.signal });
      }
      if (phase.remove) fs.unlinkSync(phase.remove);
      phase.start = Date.now();
      await delay(6000, undefined, { signal: t.signal });
      phase.end = Date.now();
    }

    const { stdout } = await run(process.execPath, [path.join(__dirname, 'post.js')], {
      env: { ...env, STATE_disk_usage_dir: directory },
      timeout: 15000,
      signal: t.signal,
    });
    console.log(stdout);
    const result = fs.readFileSync(summary, 'utf8');
    if (process.env.GITHUB_STEP_SUMMARY) {
      const start = phases[0].start;
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '## 30-second disk usage graph test',
        '',
        'Expected test-file usage: **0 -> 2 -> 4 -> 2 -> 0 GiB**, holding each level for six seconds.',
        'The chart below is the real post-action report and includes other workspace filesystem activity.',
        '',
        '| Elapsed seconds | UTC phase start | Test files (GiB) |',
        '|---|---|---:|',
        ...phases.map(phase => `| ${((phase.start - start) / 1000).toFixed(1)}-${((phase.end - start) / 1000).toFixed(1)} | ${new Date(phase.start).toISOString()} | ${phase.allocated} |`),
        '',
        result,
      ].join('\n'));
    }

    const samples = fs.readFileSync(path.join(directory, 'samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const readings = phases.map((phase, index) => {
      const entry = samples.findLast(sample => {
        const time = Date.parse(sample.time);
        return time >= phase.start && time < phase.end;
      });
      assert.ok(entry, `Phase ${index + 1} (${phase.allocated} GiB) must contain a disk usage sample.`);
      return entry;
    });
    for (let index = 1; index < phases.length; index++) {
      const direction = Math.sign(phases[index].allocated - phases[index - 1].allocated);
      const usedChange = (readings[index].used - readings[index - 1].used) / kibPerGib;
      const availableChange = (readings[index].available - readings[index - 1].available) / kibPerGib;
      const transition = `${phases[index - 1].allocated} -> ${phases[index].allocated} GiB`;
      // Require half of each 2 GiB change, allowing for unrelated runner activity.
      assert.ok(direction * usedChange >= 1,
        `${transition}: used space must ${direction > 0 ? 'rise' : 'fall'} by at least 1 GiB; observed ${usedChange.toFixed(2)} GiB.`);
      assert.ok(-direction * availableChange >= 1,
        `${transition}: available space must ${direction > 0 ? 'fall' : 'rise'} by at least 1 GiB; observed ${availableChange.toFixed(2)} GiB.`);
    }

    const lines = [...result.matchAll(/^    line \[([^\]]+)\]$/gm)];
    assert.equal(lines.length, 2, 'The chart must contain used and available space lines.');
    for (const [index, field] of ['used', 'available'].entries()) {
      assert.deepEqual(lines[index][1].split(', ').map(Number),
        samples.map(entry => Number((entry[field] / kibPerGib).toFixed(2))),
        `The ${field} chart line must preserve the measured rise and fall.`);
    }
    const timestamps = result.match(/^    x-axis "UTC time \(seconds since first sample\)" (\[[^\n]+\])$/m);
    assert.ok(timestamps, 'The x-axis must show UTC timestamps and elapsed seconds.');
    const firstTime = Date.parse(samples[0].time);
    assert.deepEqual(JSON.parse(timestamps[1]), samples.map(entry =>
      `${entry.time} (${Math.round((Date.parse(entry.time) - firstTime) / 1000)}s)`),
      'Every x-axis label must contain its raw timestamp and elapsed seconds from the first sample.');
    const bounds = result.match(/^    y-axis "GiB" ([\d.]+) --> ([\d.]+)$/m);
    assert.ok(bounds, 'The y-axis must have numeric limits.');
    const values = lines.flatMap(line => line[1].split(', ').map(Number));
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const tolerance = Math.max(0.01, (maximum - minimum) * 0.05) + 0.010001;
    assert.ok(Number(bounds[1]) <= minimum && minimum - Number(bounds[1]) <= tolerance,
      'The lower limit must fit the plotted minimum with only a small margin.');
    assert.ok(Number(bounds[2]) >= maximum && Number(bounds[2]) - maximum <= tolerance,
      'The upper limit must fit the plotted maximum with only a small margin.');
    assert.ok(fs.existsSync(path.join(directory, 'stopped')), 'The post action must stop the sampler.');
  } finally {
    for (const file of files) fs.rmSync(file, { force: true });
    if (!directory && fs.existsSync(state)) {
      directory = fs.readFileSync(state, 'utf8').match(/^disk_usage_dir=(.+)$/m)?.[1];
      assert.ok(directory, 'The main action must save its sampler directory for cleanup.');
    }
    if (directory && !fs.existsSync(path.join(directory, 'stopped'))) {
      fs.writeFileSync(path.join(directory, 'stop'), '');
      for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(directory, 'stopped')); attempt++) {
        await delay(100);
      }
      assert.ok(fs.existsSync(path.join(directory, 'stopped')), 'The sampler must stop before deleting its files.');
    }
    fs.rmSync(temporary, { recursive: true });
  }
});
