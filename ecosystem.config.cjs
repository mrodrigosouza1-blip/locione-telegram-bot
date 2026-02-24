module.exports = {
  apps: [
    {
      name: "locione-bot",
      script: "index.mjs",
      cwd: "/Users/rodrigo/Projects/locione-telegram-bot",
      interpreter: "node",
      env_file: "/Users/rodrigo/Projects/locione-telegram-bot/.env",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000
    }
  ]
};
