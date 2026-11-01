# Disk Usage Action

Sample a GitHub Actions runner's workspace filesystem every five seconds and report peak used space and minimum free space at the end of the job.

The action is independent of any build tool. It does not perform disk cleanup, require extra GitHub permissions, or send samples to an external telemetry service.

## Usage

Add the action after checkout and before setup, cache restoration, and build steps:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Monitor disk usage
        uses: ChrisCarini/disk-usage-action@v0.0.1

      # Add your setup and build steps here.
```

For reproducible, immutable references, pin the action to the release's full commit SHA instead of its tag.

Version `v0.0.1` targets Linux runners. It uses the Node 24 action runtime provided by GitHub and `df -Pk`; no npm installation is required. The monitored path is `GITHUB_WORKSPACE`, and the sampling interval is fixed at five seconds.

## Reports

The automatic **Post Monitor disk usage** step stops the sampler and publishes a job summary containing:

- A Mermaid XY chart of used and available space over the job
- Filesystem capacity
- Starting free space
- Peak observed used space
- Minimum observed free space and its timestamp
- Maximum net drop in free space from the initial sample

The summary uses GiB. Timestamped raw samples appear in the post-step logs in KiB.

The chart uses a blue line for used space and an orange line for available space, with sample number on the x-axis. Samples are taken every five seconds, plus a final sample when the post-job step stops monitoring. If only one sample is recorded, labeled bars compare used and available space instead.

For jobs with more than 60 samples, the chart groups observations into 60 evenly spaced sample windows and shows the highest used and lowest available space in each window, so brief observed peaks are not lost. Those two values can come from different samples within the same window. The numeric table always uses every sample.

The chart is emitted as a fenced `mermaid` block using `xychart`; it requires a summary viewer with Mermaid XY chart support. Viewers without that support may show the chart source instead. The numeric table and raw logs remain available regardless of chart rendering. Chart generation uses only the existing samples, with no extra dependencies, permissions, or external chart service.

Because reporting runs in a post-job hook, sampling also covers the post-job work of actions registered after this action, such as Gradle cache handling. The hook is configured to run even when later build steps fail.

## Interpreting the measurements

- These are sampled peaks; spikes shorter than five seconds can be missed.
- Measurements cover the filesystem containing the workspace, not every mounted filesystem.
- Total used space includes preinstalled runner files, not just build outputs.
- Cleanup during the job affects the net drop in free space. That value is not the build's total disk-space requirement.
- Results are available at the end of the job, not as inputs for an earlier cleanup decision in that same job.
- A destroyed runner, hard cancellation, or complete disk exhaustion can prevent the final report. Monitoring errors are reported as action failures.

The action does not currently expose configurable inputs or step outputs.

## Development

Run the focused tests with Node:

```bash
node --test index.test.js
```

CI uses Node 24 and runs the local action itself to exercise its main and post-job entrypoints on a GitHub-hosted runner.

## License

[Apache-2.0](LICENSE).
