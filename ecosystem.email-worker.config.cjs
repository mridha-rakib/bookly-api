// Opt-in only: never imported by the default API ecosystem.
// BOOKLY_EMAIL_WORKER_ENABLED=true and provider settings must be supplied by the authorized operator.
module.exports = {
  apps: [
    {
      name: "bookly-email-worker",
      cwd: __dirname,
      script: "dist/scripts/run-email-worker.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 5000,
      min_uptime: "30s",
      max_restarts: 10,
      max_memory_restart: "512M",
      // Grace for the active pass to finish its in-flight sends. Not a provider timeout.
      kill_timeout: 60000,
    },
  ],
};
