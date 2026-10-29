#!/usr/bin/env node

/**
 * Google Business Profile Review MCP Server
 *
 * Supports stdio for local MCP clients and Streamable HTTP for hosted deployments.
 */

import 'dotenv/config';
import { McpServer } from './server/mcpServer.js';
import { logger } from './utils/logger.js';
import { validateEnvironment } from './utils/config.js';
import { fileURLToPath } from 'url';
import { resolve, normalize } from 'path';

async function main() {
    try {
        logger.info('Initializing Google Business Profile Review MCP Server...');
        validateEnvironment();

        logger.info('Starting Google Business Profile Review MCP Server...');
        const mcpServer = new McpServer();
        const port = Number(process.env.PORT);

        if (Number.isInteger(port) && port > 0) {
            await mcpServer.startHttp(port);
        } else {
            await mcpServer.start();
        }

        logger.info('Google Business Profile Review MCP Server is running successfully');

        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            await mcpServer.stop();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            await mcpServer.stop();
            process.exit(0);
        });

        process.on('uncaughtException', (error) => {
            logger.error('Uncaught exception:', error);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled rejection:', { promise: promise.toString(), reason });
            process.exit(1);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

const __filename = fileURLToPath(import.meta.url);
const currentFile = normalize(resolve(__filename));
const entryPoint = normalize(resolve(process.argv[1] ?? ''));

if (entryPoint === currentFile) {
    main().catch((error) => {
        logger.error('Fatal error:', error);
        process.exit(1);
    });
} else {
    logger.info('Service not started', { moduleFile: currentFile, args: entryPoint });
}