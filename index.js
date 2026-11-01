const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const gib = kib => (kib / 1024 / 1024).toFixed(2);

function sample() {
  const output = execFileSync('df', ['-Pk', process.env.GITHUB_WORKSPACE], { encoding: 'utf8' });
  const values = output.trim().split('\n')[1]?.trim().split(/\s+/).slice(1, 4).map(Number);
  if (!values || values.length !== 3 || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Unexpected df output:\n${output}`);
  }
  const [total, used, available] = values;
  return { time: new Date().toISOString(), total, used, available };
}

function renderChart(samples) {
  const points = Array.from({ length: Math.min(samples.length, 60) }, () => ({
    used: 0,
    available: Infinity,
  }));
  for (const [index, entry] of samples.entries()) {
    // Group around evenly spaced sample positions without losing brief peaks.
    const point = points[Math.round(index * (points.length - 1) / Math.max(1, samples.length - 1))];
    point.used = Math.max(point.used, entry.used);
    point.available = Math.min(point.available, entry.available);
  }
  const capacity = samples.reduce((maximum, entry) => Math.max(maximum, entry.total), 0);
  const singleSample = samples.length === 1;
  const xAxis = singleSample
    ? '"Space" ["Used", "Available"]'
    : `"Sample number (5-second sampling)" 1 --> ${samples.length}`;
  const plots = singleSample
    ? [`    bar [${gib(points[0].used)}, ${gib(points[0].available)}]`]
    : [
      `    line [${points.map(point => gib(point.used)).join(', ')}]`,
      `    line [${points.map(point => gib(point.available)).join(', ')}]`,
    ];
  return [
    '### Disk usage over time',
    '',
    '```mermaid',
    '---',
    'config:',
    '  themeVariables:',
    '    xyChart:',
    '      plotColorPalette: "#3b82f6, #d97706"',
    '---',
    'xychart-beta',
    '    title "Workspace filesystem usage"',
    `    x-axis ${xAxis}`,
    `    y-axis "GiB" 0 --> ${Math.max(1, Math.ceil(capacity / 1024 / 1024))}`,
    ...plots,
    '```',
    '',
    singleSample
      ? 'Only one sample was recorded; the bars compare used and available space.'
      : '**Blue line:** used space. **Orange line:** available space.',
    samples.length > points.length
      ? `The chart groups ${samples.length} samples into ${points.length} evenly spaced sample windows, showing peak used and minimum available space in each window. The table below uses every sample.`
      : 'Sampling includes a final post-job sample.',
    '',
  ].join('\n');
}

function summarize(samples) {
  if (samples.length === 0) {
    throw new Error('No disk usage samples were recorded.');
  }
  const first = samples[0];
  const peak = samples.reduce((a, b) => a.used >= b.used ? a : b);
  const minimum = samples.reduce((a, b) => a.available <= b.available ? a : b);
  return [
    '## Disk usage (5-second samples)',
    '',
    renderChart(samples),
    '| Measurement | GiB |',
    '|---|---:|',
    `| Filesystem capacity | ${gib(first.total)} |`,
    `| Starting free space | ${gib(first.available)} |`,
    `| Peak observed used space | ${gib(peak.used)} |`,
    `| Minimum observed free space | ${gib(minimum.available)} |`,
    `| Maximum net drop in free space from start | ${gib(first.available - minimum.available)} |`,
    '',
    `Lowest free space observed at ${minimum.time}.`,
    '',
    'Includes preinstalled runner files. Cleanup during the job affects the net drop; it is not the total space required by the build.',
    'Spikes shorter than five seconds may be missed.',
    '',
  ].join('\n');
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error('Disk usage sampler did not respond within ten seconds.');
}

async function monitor(directory) {
  const record = () => fs.appendFileSync(path.join(directory, 'samples.jsonl'), `${JSON.stringify(sample())}\n`);
  try {
    while (!fs.existsSync(path.join(directory, 'stop'))) {
      record();
      await delay(5000);
    }
    record();
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'error'), error.stack);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(directory, 'stopped'), '');
  }
}

async function start() {
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'disk-usage-'));
  fs.appendFileSync(process.env.GITHUB_STATE, `disk_usage_dir=${directory}\n`);
  const log = fs.openSync(path.join(directory, 'monitor.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [__filename, 'monitor', directory], {
      detached: true,
      stdio: ['ignore', 'ignore', log],
    });
    await once(child, 'spawn');
  } finally {
    fs.closeSync(log);
  }
  child.unref();
  await waitFor(() => fs.existsSync(path.join(directory, 'samples.jsonl')) || fs.existsSync(path.join(directory, 'stopped')));
  if (fs.existsSync(path.join(directory, 'error'))) {
    throw new Error(fs.readFileSync(path.join(directory, 'error'), 'utf8'));
  }
  console.log(`Sampling disk usage for ${process.env.GITHUB_WORKSPACE} every five seconds.`);
  console.log('Results will appear in the post-job step and job summary.');
}

async function report() {
  const directory = process.env.STATE_disk_usage_dir;
  if (!directory) throw new Error('Disk usage monitoring did not initialize.');
  fs.writeFileSync(path.join(directory, 'stop'), '');
  await waitFor(() => fs.existsSync(path.join(directory, 'stopped')));
  const log = fs.readFileSync(path.join(directory, 'monitor.log'), 'utf8');
  if (log) console.log(log);
  if (fs.existsSync(path.join(directory, 'error'))) {
    throw new Error(fs.readFileSync(path.join(directory, 'error'), 'utf8'));
  }
  const samples = fs.readFileSync(path.join(directory, 'samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  console.log('::group::Disk usage samples (UTC; KiB)');
  console.log('Time\tTotal\tUsed\tAvailable');
  for (const entry of samples) {
    console.log(`${entry.time}\t${entry.total}\t${entry.used}\t${entry.available}`);
  }
  console.log('::endgroup::');
  const summary = summarize(samples);
  console.log(summary);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

function fail(error) {
  console.error('::error::Disk usage monitoring failed.');
  console.error(error);
  process.exitCode = 1;
}

module.exports = { summarize, report, fail };
if (require.main === module) {
  (process.argv[2] === 'monitor' ? monitor(process.argv[3]) : start()).catch(fail);
}
