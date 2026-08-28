module.exports = {
  apps: [
    {
      name: 'dashcam-server',
      script: 'backend/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        JT808_PORT: 7788,
        JT808_ALT_PORT: 8088,
        JT1078_PORT: 1078
      }
    }
  ]
};
