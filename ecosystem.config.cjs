/**
 * PM2 cluster config — the load balancer for a single MilesWeb Node.js box.
 *
 * `exec_mode: 'cluster'` runs one Next.js server per CPU core and PM2's
 * built-in round-robin balancer distributes requests across them, so a
 * 5000-candidate burst uses the whole machine instead of one core.
 *
 * Install once on the server:  npm i -g pm2
 * Start / reload (zero-downtime): pm2 startOrReload ecosystem.config.cjs
 * Save across reboots:           pm2 save && pm2 startup
 *
 * Tuning:
 *   - `instances: 'max'`        = one worker per core. Set WEB_CONCURRENCY=n
 *     (in the server .env) to pin an exact number, e.g. `WEB_CONCURRENCY=2`
 *     on a small shared plan so you don't exhaust the host's process limit.
 *   - `max_memory_restart`      = auto-restart a worker that leaks/OOMs.
 *   - `listen_timeout` / `kill_timeout` = give workers time to drain on reload.
 */
module.exports = {
  apps: [
    {
      name: 'calibiai',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 0.0.0.0',
      cwd: __dirname,
      instances: process.env.WEB_CONCURRENCY ? parseInt(process.env.WEB_CONCURRENCY, 10) : 'max',
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      listen_timeout: 20000,
      kill_timeout: 8000,
      exp_backoff_restart_delay: 500,
      env: {
        NODE_ENV: 'production',
      },
      // Next.js standalone-ish behaviour: keep the logs bounded.
      out_file: './logs/calibiai-out.log',
      error_file: './logs/calibiai-error.log',
      merge_logs: true,
      time: true,
    },
  ],
}
