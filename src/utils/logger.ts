/**
 * Logging utility for the Google Business Profile Review MCP Server
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    data?: any;
}

function serializeError(value: any): any {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack
        };
    }
    if (Array.isArray(value)) return value.map(serializeError);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeError(item)]));
    }
    return value;
}

class Logger {
    private logLevel: LogLevel;
    private isStdioTransport: boolean;

    constructor() {
        this.logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
        this.isStdioTransport = process.env.TRANSPORT_MODE === 'stdio';
    }

    private shouldLog(level: LogLevel): boolean {
        const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
        return levels[level] >= levels[this.logLevel];
    }

    private formatMessage(level: LogLevel, message: string, data?: any): string {
        const logEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...(data !== undefined && { data: serializeError(data) })
        };
        return JSON.stringify(logEntry);
    }

    private log(level: LogLevel, message: string, data?: any): void {
        if (!this.shouldLog(level)) return;
        process.stderr.write(this.formatMessage(level, message, data) + '\n');
    }

    debug(message: string, data?: any): void { this.log('debug', message, data); }
    info(message: string, data?: any): void { this.log('info', message, data); }
    warn(message: string, data?: any): void { this.log('warn', message, data); }
    error(message: string, data?: any): void { this.log('error', message, data); }

    stdioDebug(message: string): void {
        if (this.isStdioTransport && this.logLevel === 'debug' && process.env.NODE_ENV !== 'production') {
            process.stderr.write(`[STDIO DEBUG] ${message}\n`);
        }
    }
}

export const logger = new Logger();
