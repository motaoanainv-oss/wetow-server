// PM2 Ecosystem Configuration for WeTow Cars Server
// This file tells PM2 how to run and manage the server

module.exports = {
  apps: [{
    name: 'wetow-server',
    script: 'server.js',
    cwd: 'C:\\WeTow\\server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'development',
      PORT: 3001
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: 'logs/error.log',
    out_file: 'logs/output.log',
    log_file: 'logs/combined.log',
    time: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};