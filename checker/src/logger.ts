import winston from 'winston';

function redact(value: unknown, seen: Set<object> = new Set()): unknown {
  if (typeof value === 'string') {
    // Never log full wallet addresses: EQ/UQ + 44 chars -> EQ..xxxx
    return value.replace(/\b([UE]Q[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{34,}\b/g, '$1..redacted');
  }
  if (value instanceof Error) {
    // Errors (and fetch Response/Request objects) carry circular refs —
    // log a flat summary instead of recursing into them.
    const anyErr = value as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { message: value.message };
    for (const k of ['code', 'status', 'statusCode', 'errno', 'syscall']) {
      if (anyErr[k] !== undefined) {
        try {
          out[k] = typeof anyErr[k] === 'string' ? redact(anyErr[k] as string) : anyErr[k];
        } catch {
          /* ignore */
        }
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.map((v) => redact(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      try {
        out[k] = redact(v, seen);
      } catch {
        out[k] = '[unprintable]';
      }
    }
    return out;
  }
  return value;
}

/**
 * Sanitize user-controlled values before embedding in log messages.
 * Escapes control characters (newlines, CR) so attackers cannot
 * forge/spoof log lines (CWE-117), and truncates overly long values.
 */
export function sanitizeLogValue(v: unknown, max = 200): string {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (v === null || v === undefined) s = '';
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  // Strip newlines up front: CR/LF are the log-forging vector. The first
  // `.replace(/\n/g, '')` step is exactly the shape CodeQL js/log-injection
  // models as a barrier (StringReplaceSanitizer), so this helper keeps both
  // runtime logs and static analysis clean.
  const singleLine = s.replace(/\n/g, '').replace(/\r/g, '');
  // Control-char class is intentional here: this IS the log-injection sanitizer.
  // eslint-disable-next-line no-control-regex
  const escaped = singleLine.replace(/[\x00-\x1F\x7F]/g, (c) => {
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return escaped.length > max ? escaped.slice(0, max) + '…' : escaped;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf((info) => {
      const rest = redact(info[Symbol.for('splat')] ?? []);
      const extra = Array.isArray(rest) && rest.length ? ` ${JSON.stringify(redact(rest))}` : '';
      return `${info.level}: ${String(info.message)}${extra} {"timestamp":"${info.timestamp}"}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
