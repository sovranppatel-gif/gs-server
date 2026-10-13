const path = require('node:path');
module.exports = {
  apps: [{
    name: 'growskills-api',
    cwd: path.resolve(__dirname, '..'),
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    autorestart: true,
    restart_delay: 5000,
    kill_timeout: 45000,
    max_memory_restart: '512M',
    env_production: { NODE_ENV: 'production' },
  }],
};
