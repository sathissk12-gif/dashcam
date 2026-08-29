function formatLog(level, event, meta = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...meta
  });
}

const logger = {
  info: (event, meta) => console.log(formatLog('INFO', event, meta)),
  warn: (event, meta) => console.warn(formatLog('WARN', event, meta)),
  error: (event, meta) => console.error(formatLog('ERROR', event, meta)),
  debug: (event, meta) => {
    if (process.env.DEBUG === 'true') {
      console.log(formatLog('DEBUG', event, meta));
    }
  }
};

module.exports = logger;
