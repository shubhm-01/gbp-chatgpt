/**
 * Token storage utilities for persisting OAuth tokens
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import type { GoogleOAuthTokens } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TOKENS_FILE = join(__dirname, '../../.tokens.json');

/**
 * Load tokens from disk
 */
export function loadTokens(): GoogleOAuthTokens | null {
    try {
        // Render's filesystem is ephemeral across deploys; prefer the secret env var
        // for a durable refresh token when one has been configured.
        const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
        if (refreshToken) {
            return {
                access_token: '',
                refresh_token: refreshToken,
                scope: 'https://www.googleapis.com/auth/business.manage',
                token_type: 'Bearer',
                expires_in: 0,
                expires_at: 0
            };
        }

        if (!existsSync(TOKENS_FILE)) {
            logger.debug('No token file found');
            return null;
        }
        
        const data = readFileSync(TOKENS_FILE, 'utf-8');
        const tokens = JSON.parse(data);
        
        logger.debug('Tokens loaded from disk');
        return tokens;
        
    } catch (error) {
        logger.error('Error loading tokens:', error);
        return null;
    }
}

/**
 * Save tokens to disk
 */
export function saveTokens(tokens: GoogleOAuthTokens): boolean {
    try {
        writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        logger.debug('Tokens saved to disk');
        return true;
        
    } catch (error) {
        logger.error('Error saving tokens:', error);
        return false;
    }
}

/**
 * Check if tokens exist
 */
export function hasStoredTokens(): boolean {
    return existsSync(TOKENS_FILE);
}

/**
 * Clear stored tokens
 */
export function clearTokens(): boolean {
    try {
        if (existsSync(TOKENS_FILE)) {
            writeFileSync(TOKENS_FILE, '');
            logger.debug('Tokens cleared');
        }
        return true;
        
    } catch (error) {
        logger.error('Error clearing tokens:', error);
        return false;
    }
}
