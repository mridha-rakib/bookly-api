// Opt-in only: never imported by the default API ecosystem.
// Both launch acknowledgements must be supplied by the authorized operator.
module.exports = {
  apps: [
    {
      name: "bookly-money-recovery",
      cwd: __dirname,
      script: "dist/scripts/run-money-recovery-worker.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 5000,
      min_uptime: "30s",
      max_restarts: 10,
      max_memory_restart: "512M",
      // Grace period, not a bound on provider/DB work. See the runtime contract.
      kill_timeout: 120000,
    },
  ],
};
