import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

export const logger = pino({
  level: logLevel,
  redact: {
    paths: [
      'DISCORD_TOKEN',
      'token',
      'password',
      'DATABASE_URL',
      'authorization',
      'headers.authorization',
      '*.token',
      '*.password'
    ],
    censor: '[REDACTED]'
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname'
        }
      }
});

export default logger;
