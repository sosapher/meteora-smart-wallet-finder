module.exports = {
  apps: [
    {
      name: "meteora-smart-wallet-finder",
      script: "finder.js",
      args: "watch",
      cwd: __dirname,
      interpreter: "node",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "60s",
      restart_delay: 5000,
      time: true,
      out_file: "data/pm2-out.log",
      error_file: "data/pm2-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
