module.exports = {
  apps: [
    {
      name: "bookly-api",
      script: "dist/app/server.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      kill_timeout: 10000,
    },
  ],
};
