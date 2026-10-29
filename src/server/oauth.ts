import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';

const BASE_URL = (process.env.RENDER_EXTERNAL_URL || 'https://gbp-chatgpt.onrender.com').replace(/\/$/, '');
const MCP_RESOURCE = `${BASE_URL}/mcp`;
const RESOURCE_METADATA = `${BASE_URL}/.well-known/oauth-protected-resource`;
const ISSUER = BASE_URL;
const AUTHORIZATION_ENDPOINT = `${BASE_URL}/oauth/authorize`;
const TOKEN_ENDPOINT = `${BASE_URL}/oauth/token`;
const REGISTRATION_ENDPOINT = `${BASE_URL}/oauth/register`;

type OAuthCode = {
    clientId: string;
    redirectUri: string;
    challenge: string;
    resource: string;
    expiresAt: number;
};

type RegisteredClient = { redirectUris: string[]; name: string };
const authorizationCodes = new Map<string, OAuthCode>();
const registeredClients = new Map<string, RegisteredClient>();

function isChatGptRedirect(uri: string): boolean {
    try {
        const parsed = new URL(uri);
        return parsed.protocol === 'https:' &&
            parsed.hostname === 'chatgpt.com' &&
            ( /^\/connector\/oauth\/[^/]+\/?$/.test(parsed.pathname) ||
              parsed.pathname === '/connector_platform_oauth_redirect' );
    } catch {
        return false;
    }
}

function isChatGptMetadataClient(clientId: string): boolean {
    try {
        const parsed = new URL(clientId);
        return parsed.protocol === 'https:' &&
            parsed.hostname === 'chatgpt.com' &&
            (parsed.pathname === '/oauth/client.json' || /^\/oauth\/[^/]+\/client\.json$/.test(parsed.pathname));
    } catch {
        return false;
    }
}

function clientIsAllowed(clientId: string, redirectUri?: string): boolean {
    if (isChatGptMetadataClient(clientId)) return !!redirectUri && isChatGptRedirect(redirectUri);
    const client = registeredClients.get(clientId);
    if (client) return !redirectUri || client.redirectUris.includes(redirectUri);
    // DCR registrations are ephemeral on this single-instance service; retain the
    // high-entropy issued ID shape across restarts while still restricting redirects.
    return /^[0-9a-f]{48}$/.test(clientId) && (!redirectUri || isChatGptRedirect(redirectUri));
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function constantTimeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

function signToken(payload: Record<string, unknown>, secret: string): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
}

function verifyToken(token: string, secret: string): Record<string, unknown> | undefined {
    const parts = token.split('.');
    if (parts.length !== 2) return undefined;
    const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
    if (!constantTimeEqual(expected, parts[1])) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
        if (payload.iss !== ISSUER || payload.aud !== MCP_RESOURCE) return undefined;
        return payload;
    } catch {
        return undefined;
    }
}

function issueTokenPair(secret: string, scope: string) {
    const now = Math.floor(Date.now() / 1000);
    const common = { iss: ISSUER, aud: MCP_RESOURCE, sub: 'gbp-owner', scope, iat: now };
    return {
        access_token: signToken({ ...common, typ: 'access', exp: now + 3600 }, secret),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: signToken({ ...common, typ: 'refresh', exp: now + 60 * 60 * 24 * 30 }, secret),
        scope
    };
}

export function isValidMcpAccessToken(token: string, secret?: string): boolean {
    if (!secret || !token) return false;
    const payload = verifyToken(token, secret);
    return payload?.typ === 'access' &&
        typeof payload.scope === 'string' &&
        payload.scope.split(' ').includes('reviews:read') &&
        payload.scope.split(' ').includes('reviews:write');
}

export function protectedResourceMetadataUrl(): string {
    return RESOURCE_METADATA;
}

export function registerOAuthEndpoints(app: Express): void {
    const resourceMetadata = {
        resource: MCP_RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['reviews:read', 'reviews:write'],
        resource_documentation: BASE_URL
    };
    const authorizationMetadata = {
        issuer: ISSUER,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
        registration_endpoint: REGISTRATION_ENDPOINT,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        scopes_supported: ['reviews:read', 'reviews:write']
    };

    app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(resourceMetadata));
    app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(resourceMetadata));
    app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(authorizationMetadata));
    app.get('/.well-known/oauth-authorization-server/mcp', (_req, res) => res.json(authorizationMetadata));

    app.post('/oauth/register', (req: Request, res: Response) => {
        const redirectUris = req.body?.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 ||
            !redirectUris.every((uri: unknown) => typeof uri === 'string' && isChatGptRedirect(uri))) {
            res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Only ChatGPT HTTPS redirect URIs are supported.' });
            return;
        }
        const clientId = randomBytes(24).toString('hex');
        registeredClients.set(clientId, {
            redirectUris,
            name: typeof req.body?.client_name === 'string' ? req.body.client_name : 'ChatGPT MCP client'
        });
        res.status(201).json({
            client_id: clientId,
            client_name: registeredClients.get(clientId)?.name,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code']
        });
    });

    app.get('/oauth/authorize', (req: Request, res: Response) => {
        const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : '';
        const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
        const responseType = typeof req.query.response_type === 'string' ? req.query.response_type : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const challenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
        const method = typeof req.query.code_challenge_method === 'string' ? req.query.code_challenge_method : '';
        const resource = typeof req.query.resource === 'string' ? req.query.resource : '';

        if (responseType !== 'code' || !clientIsAllowed(clientId, redirectUri) ||
            !state || !/^[A-Za-z0-9._~-]{20,200}$/.test(challenge) || method !== 'S256' ||
            resource !== MCP_RESOURCE) {
            res.status(400).type('text').send('Invalid OAuth request. Return to ChatGPT and retry connection setup.');
            return;
        }

        const fields = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
            state, code_challenge: challenge, code_challenge_method: 'S256', resource };
        const hiddenFields = Object.entries(fields).map(([key, value]) =>
            `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`).join('');
        res.type('html').send(
            '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Authorize GBP reviews</title></head><body style="font:16px system-ui;max-width:560px;margin:48px auto;padding:0 20px">' +
            '<h1>Connect Google Business Profile reviews</h1><p>This authorizes ChatGPT to read reviews and publish replies through your configured GBP account.</p>' +
            '<p>Enter your private setup key from Render to continue. This is separate from your Google refresh token.</p>' +
            '<form method="post" action="/oauth/authorize">' + hiddenFields +
            '<label>OAuth setup key<br><input type="password" name="setup_key" required autocomplete="current-password" style="width:100%;padding:12px;margin:8px 0 16px;box-sizing:border-box"></label>' +
            '<button type="submit" style="padding:12px 18px">Authorize ChatGPT</button></form></body></html>'
        );
    });

    app.post('/oauth/authorize', (req: Request, res: Response) => {
        const configuredKey = process.env.GOOGLE_OAUTH_SETUP_KEY;
        const setupKey = typeof req.body?.setup_key === 'string' ? req.body.setup_key : '';
        const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
        const redirectUri = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';
        const state = typeof req.body?.state === 'string' ? req.body.state : '';
        const challenge = typeof req.body?.code_challenge === 'string' ? req.body.code_challenge : '';
        const resource = typeof req.body?.resource === 'string' ? req.body.resource : '';

        if (!configuredKey || !constantTimeEqual(setupKey, configuredKey)) {
            res.status(401).type('text').send('Incorrect setup key. Check GOOGLE_OAUTH_SETUP_KEY in Render and try again.');
            return;
        }
        if (!clientIsAllowed(clientId, redirectUri) || !state ||
            !/^[A-Za-z0-9._~-]{20,200}$/.test(challenge) || resource !== MCP_RESOURCE) {
            res.status(400).type('text').send('Invalid or expired OAuth request. Return to ChatGPT and reconnect.');
            return;
        }

        const now = Date.now();
        for (const [code, details] of authorizationCodes.entries()) {
            if (details.expiresAt <= now) authorizationCodes.delete(code);
        }
        const code = randomBytes(32).toString('base64url');
        authorizationCodes.set(code, { clientId, redirectUri, challenge, resource, expiresAt: now + 5 * 60 * 1000 });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        // ChatGPT validates the authorization-server issuer on the callback.
        target.searchParams.set('iss', ISSUER);
        res.redirect(302, target.toString());
    });

    app.post('/oauth/token', (req: Request, res: Response) => {
        const secret = process.env.MCP_AUTH_TOKEN;
        if (!secret) {
            res.status(503).json({ error: 'server_error', error_description: 'OAuth signing secret is not configured.' });
            return;
        }
        const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : '';
        const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
        const resource = typeof req.body?.resource === 'string' ? req.body.resource : '';
        if (!clientIsAllowed(clientId) || resource !== MCP_RESOURCE) {
            console.warn('[OAuth] Token request rejected: invalid client or resource');
            res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache')
                .status(400).json({ error: 'invalid_request', error_description: 'Invalid client or resource.' });
            return;
        }

        if (grantType === 'authorization_code') {
            const code = typeof req.body?.code === 'string' ? req.body.code : '';
            const redirectUri = typeof req.body?.redirect_uri === 'string' ? req.body.redirect_uri : '';
            const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : '';
            const pending = authorizationCodes.get(code);
            authorizationCodes.delete(code);
            if (!pending || pending.expiresAt <= Date.now() || pending.clientId !== clientId ||
                pending.redirectUri !== redirectUri || pending.resource !== resource ||
                !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
                res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' });
                return;
            }
            const expected = createHash('sha256').update(verifier).digest('base64url');
            if (!constantTimeEqual(expected, pending.challenge)) {
                res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
                return;
            }
            console.info('[OAuth] Authorization-code exchange succeeded');
            res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache')
                .json(issueTokenPair(secret, 'reviews:read reviews:write'));
            return;
        }

        if (grantType === 'refresh_token') {
            const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
            const payload = verifyToken(refreshToken, secret);
            if (!payload || payload.typ !== 'refresh' || payload.sub !== 'gbp-owner') {
                res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired. Reconnect the plugin.' });
                return;
            }
            console.info('[OAuth] Refresh-token exchange succeeded');
            res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache')
                .json(issueTokenPair(secret, typeof payload.scope === 'string' ? payload.scope : 'reviews:read reviews:write'));
            return;
        }

        res.status(400).json({ error: 'unsupported_grant_type' });
    });
}
