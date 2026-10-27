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
    // Optional Telegram control bot. Uncomment this block after setting
    // telegram.botToken and telegram.allowedChatIds in config.json.
    // Do not run this together with the watch app above: both can start scans.
    // {
    //   name: "meteora-wallet-bot",
    //   script: "finder.js",
    //   args: "bot",
    //   cwd: __dirname,
    //   interpreter: "node",
    //   autorestart: true,
    //   max_restarts: 10,
    //   min_uptime: "60s",
    //   restart_delay: 5000,
    //   time: true,
    //   out_file: "data/bot-out.log",
    //   error_file: "data/bot-error.log",
    //   merge_logs: true,
    //   env: {
    //     NODE_ENV: "production",
    //   },
    // },
  ],
};
