// PM2 : bot en daemon (redemarrage auto). Lancement : pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    min_uptime: '10s',
    max_restarts: 20,
    env: { NODE_ENV: 'production', PORT: 3000 },
  }],
};
