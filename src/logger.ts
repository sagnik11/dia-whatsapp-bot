import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    serializers: {
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: ["openaiApiKey", "notionApiKey", "*.token", "*.authorization"],
      censor: "[REDACTED]",
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
