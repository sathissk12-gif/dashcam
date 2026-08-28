module.exports = {
  apps: [
    {
      name: 'dashcam-backend',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 9090,
        JT808_PORT: 5023,
        JT808_ALT1: 9901,
        JT808_ALT2: 7788,
        JT1078_PORT: 8081
      }
    }
  ]
};
