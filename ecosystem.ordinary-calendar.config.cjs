// P2.2.9.1 — opt-in only: never imported by the default API ecosystem or the Docker CMD.
// Runs the existing ordinary Calendar worker as ONE extra forked process on the host that
// already runs the API (no new paid resource). It refuses to start while the reliable-delivery
// authority is denied (the default) and refuses to deliver unless both journal indexes exist.
// Start only after the activation runbook (docs/GOOGLE-CALENDAR-ACTIVATION.md) is complete.
module.exports = {
  apps: [
    {
      name: "bookly-ordinary-calendar",
      cwd: __dirname,
      script: "dist/scripts/run-ordinary-calendar-worker.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 5000,
      min_uptime: "30s",
      // P2.2.9.2 — a denied authority or unprovisioned journal exits 78 (deliberate refusal):
      // never restarted. Genuine failures (exit 1) restart, bounded by max_restarts.
      stop_exit_codes: [78],
      max_restarts: 10,
      max_memory_restart: "256M",
      // Longer than the 45 s claim lease plus one 10 s Google call: lets an in-flight delivery
      // drain on stop. An interrupted call stays a durable, observable uncertain request.
      kill_timeout: 70000,
    },
  ],
};
