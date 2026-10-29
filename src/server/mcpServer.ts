/**
 * Main MCP Server implementation for Google Business Profile Review management
 */

import { McpServer as BaseMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';

import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { GoogleAuthService } from '../services/googleAuth.js';
import { ReviewService } from '../services/reviewService.js';
import { MockReviewService } from '../services/mockReviewService.js';
import { LLMService } from '../services/llmService.js';
import type { IReviewService } from '../types/index.js';

// Import tool implementations
import { createListLocationsTool } from './tools/listLocations.js';
import { createGetUnRepliedReviewsTool } from './tools/getReviews.js';
import { createGenerateReplyTool } from './tools/generateReply.js';
import { createPostReplyTool } from './tools/postReply.js';
import { createGetReviewDayStatsTool } from './tools/getReviewDayStats.js';

// Import resource implementations
import { createBusinessProfileResource } from './resources/businessProfile.js';
import { createReviewTemplatesResource } from './resources/reviewTemplates.js';
import { createLocationsResource } from './resources/locations.js';
import { createReviewsResource } from './resources/reviews.js';

// Import prompt implementations
import { createReviewResponsePrompt } from './prompts/reviewResponse.js';
import { createSentimentAnalysisPrompt } from './prompts/sentimentAnalysis.js';
import { createManageReviewsPrompt } from './prompts/manageReviews.js';
import { createAnalyzeReviewStatsPrompt } from './prompts/analyzeReviewStats.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

export class McpServer {
    private config = getConfig();
    private server: BaseMcpServer;
    
    // Services
    private googleAuthService?: GoogleAuthService;
    private reviewService: IReviewService;
    private llmService: LLMService;
    private isMockMode: boolean;
    
    constructor() {
        this.isMockMode = process.env.NODE_ENV === 'test' || 
                         process.env.NODE_ENV === 'development' || 
                         process.env.ENABLE_MOCK_MODE === 'true';
        
        this.server = new BaseMcpServer(
            { name: this.config.mcpServerName, version: this.config.mcpServerVersion },
            { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
        );
        
        if (this.isMockMode) {
            logger.info('Starting in MOCK MODE - No Google API required');
            this.reviewService = new MockReviewService();
        } else {
            logger.info('Starting in PRODUCTION MODE - Google API required');
            this.googleAuthService = new GoogleAuthService();
            this.reviewService = new ReviewService(this.googleAuthService);
        }
        
        this.llmService = new LLMService();
        this.setupServer();
    }
    
    private setupServer(): void {
        logger.info('Setting up MCP server tools, resources, and prompts...');
        this.registerTools();
        this.registerResources();
        this.registerPrompts();
        logger.info('MCP server setup completed');
    }
    
    private registerTools(): void {
        logger.debug('Registering MCP tools...');
        const listLocationsTool = createListLocationsTool(this.reviewService);
        this.server.registerTool('list_locations', {
            title: listLocationsTool.schema.title,
            description: listLocationsTool.schema.description,
            inputSchema: {},
            outputSchema: listLocationsTool.schema.outputSchema
        }, async (args: any) => await listLocationsTool.handler(args));
        
        const getUnrepliedReviewsTool = createGetUnRepliedReviewsTool(this.reviewService);
        this.server.registerTool('get_unreplied_reviews', {
            title: getUnrepliedReviewsTool.schema.title,
            description: getUnrepliedReviewsTool.schema.description,
            inputSchema: getUnrepliedReviewsTool.schema.inputSchema,
            outputSchema: getUnrepliedReviewsTool.schema.outputSchema
        }, async (args: any) => await getUnrepliedReviewsTool.handler(args));
        
        const generateReplyTool = createGenerateReplyTool(this.llmService);
        this.server.registerTool('generate_reply', {
            title: generateReplyTool.schema.title,
            description: generateReplyTool.schema.description,
            inputSchema: generateReplyTool.schema.inputSchema,
            outputSchema: generateReplyTool.schema.outputSchema
        }, async (args: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => await generateReplyTool.handler(args, extra));
        
        const postReplyTool = createPostReplyTool(this.reviewService);
        this.server.registerTool('post_reply', {
            title: postReplyTool.schema.title,
            description: postReplyTool.schema.description,
            inputSchema: postReplyTool.schema.inputSchema,
            outputSchema: postReplyTool.schema.outputSchema
        }, async (args: any) => await postReplyTool.handler(args));
        
        const getReviewDayStatsTool = createGetReviewDayStatsTool(this.reviewService);
        this.server.registerTool('get_review_day_stats', {
            title: getReviewDayStatsTool.schema.title,
            description: getReviewDayStatsTool.schema.description,
            inputSchema: getReviewDayStatsTool.schema.inputSchema,
            outputSchema: getReviewDayStatsTool.schema.outputSchema
        }, async (args: any) => await getReviewDayStatsTool.handler(args));
        logger.debug('Tools registered successfully');
    }
    
    private registerResources(): void {
        const businessProfileResource = createBusinessProfileResource(this.reviewService);
        this.server.registerResource('business_profile', businessProfileResource.uri, {
            description: businessProfileResource.description, mimeType: businessProfileResource.mimeType
        }, async () => ({ contents: (await businessProfileResource.handler()).contents }));
        
        const reviewTemplatesResource = createReviewTemplatesResource();
        this.server.registerResource('review_templates', reviewTemplatesResource.uri, {
            description: reviewTemplatesResource.description, mimeType: reviewTemplatesResource.mimeType
        }, async () => ({ contents: (await reviewTemplatesResource.handler()).contents }));
        
        const locationsResource = createLocationsResource(this.reviewService);
        this.server.registerResource('locations', locationsResource.uri, {
            description: locationsResource.description, mimeType: locationsResource.mimeType
        }, async () => ({ contents: (await locationsResource.handler()).contents }));
        
        const reviewsResource = createReviewsResource(this.reviewService);
        this.server.registerResource('reviews_by_location', 'reviews://{locationId}', {
            description: 'Reviews for a specific business location. Use the location ID (e.g., locations/123456789)',
            mimeType: reviewsResource.mimeType
        }, async (uri: URL) => ({ contents: (await reviewsResource.handler(uri.href)).contents }));
        this.server.registerResource('reviews_all', 'reviews://all', {
            description: 'All unreplied reviews across all business locations', mimeType: reviewsResource.mimeType
        }, async () => ({ contents: (await reviewsResource.handler('reviews://all')).contents }));
        logger.debug('Resources registered successfully');
    }
    
    private registerPrompts(): void {
        const reviewResponsePrompt = createReviewResponsePrompt();
        this.server.registerPrompt('review_response', {
            title: 'Review Response Generator', description: reviewResponsePrompt.description,
            argsSchema: {
                reviewText: z.string().describe('The customer review text'),
                starRating: z.string().describe('Star rating (1-5)'),
                businessName: z.string().describe('Name of the business'),
                businessType: z.string().optional().describe('Type of business (restaurant, retail, etc.)'),
                customerName: z.string().optional().describe('Customer display name'),
                replyTone: z.string().describe('Desired tone for the reply'),
                previousReplies: z.string().optional().describe('JSON array of previous replies for consistency')
            }
        }, async (args: any) => {
            const prompt = await reviewResponsePrompt.handler({
                reviewText: args.reviewText, starRating: parseInt(args.starRating), businessName: args.businessName,
                businessType: args.businessType, customerName: args.customerName, replyTone: args.replyTone,
                previousReplies: args.previousReplies ? JSON.parse(args.previousReplies) : []
            });
            return { description: `Review response prompt for ${args.businessName}`, messages: [{ role: 'user', content: { type: 'text', text: prompt } }] };
        });
        
        const sentimentAnalysisPrompt = createSentimentAnalysisPrompt();
        this.server.registerPrompt('sentiment_analysis', {
            title: 'Review Sentiment Analysis', description: sentimentAnalysisPrompt.description,
            argsSchema: {
                reviewText: z.string().describe('The review text to analyze'),
                includeEmotions: z.string().optional().describe('Include emotional analysis (true/false)'),
                includeKeywords: z.string().optional().describe('Include keyword extraction (true/false)')
            }
        }, async (args: any) => {
            const prompt = await sentimentAnalysisPrompt.handler({
                reviewText: args.reviewText, includeEmotions: args.includeEmotions !== 'false', includeKeywords: args.includeKeywords !== 'false'
            });
            return { description: `Sentiment analysis for review: "${args.reviewText.substring(0, 50)}..."`, messages: [{ role: 'user', content: { type: 'text', text: prompt } }] };
        });
        
        const manageReviewsPrompt = createManageReviewsPrompt();
        this.server.registerPrompt('manage_pending_reviews', {
            title: 'Manage Pending Reviews', description: manageReviewsPrompt.description, argsSchema: {}
        }, async () => {
            const prompt = await manageReviewsPrompt.handler();
            return { description: 'Instructions to manage pending reviews using MCP resources', messages: [{ role: 'user', content: { type: 'text', text: prompt } }] };
        });
        
        const analyzeReviewStatsPrompt = createAnalyzeReviewStatsPrompt();
        this.server.registerPrompt('analyze_review_stats', {
            title: 'Analyze Review Statistics', description: analyzeReviewStatsPrompt.description, argsSchema: {}
        }, async () => {
            const prompt = await analyzeReviewStatsPrompt.handler();
            return { description: 'Instructions to analyze review statistics with comprehensive insights', messages: [{ role: 'user', content: { type: 'text', text: prompt } }] };
        });
        logger.debug('Prompts registered successfully');
    }
    
    async start(): Promise<void> {
        logger.info('Starting MCP server with STDIO transport...');
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        logger.info('MCP server started with STDIO transport');
        return new Promise<void>(() => {});
    }

    async startHttp(port: number): Promise<void> {
        const app = express();
        app.use(express.json());
        app.use(express.urlencoded({ extended: false }));

        // OAuth state is short-lived and single-use to prevent callback CSRF.
        const pendingOAuthStates = new Map<string, number>();

        app.get('/auth', (_req, res) => {
            res.type('html').send(
                '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>Google Business Profile connection</title></head><body style="font:16px system-ui;max-width:620px;margin:48px auto;padding:0 20px">' +
                '<h1>Connect Google Business Profile</h1><p>Enter the setup key configured in Render to continue to Google authorization.</p>' +
                '<form action="/auth/start" method="post"><label>Setup key<br><input type="password" name="key" required autocomplete="current-password" style="width:100%;padding:12px;margin:8px 0 16px;box-sizing:border-box"></label>' +
                '<button type="submit" style="padding:12px 18px">Continue to Google</button></form></body></html>'
            );
        });

        app.post('/auth/start', (req, res) => {
            const configuredKey = process.env.GOOGLE_OAUTH_SETUP_KEY;
            const suppliedKey = typeof req.body?.key === 'string' ? req.body.key : '';
            if (!configuredKey) {
                res.status(503).type('text').send('OAuth setup is disabled. Add GOOGLE_OAUTH_SETUP_KEY in Render Environment first.');
                return;
            }
            const supplied = Buffer.from(suppliedKey);
            const expected = Buffer.from(configuredKey);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                res.status(401).type('text').send('Incorrect setup key. Check GOOGLE_OAUTH_SETUP_KEY in Render.');
                return;
            }
            if (!this.googleAuthService) {
                res.status(503).type('text').send('Google OAuth is unavailable in mock mode.');
                return;
            }

            const now = Date.now();
            for (const [oldState, createdAt] of pendingOAuthStates.entries()) {
                if (now - createdAt > 10 * 60 * 1000) pendingOAuthStates.delete(oldState);
            }
            const state = randomBytes(32).toString('hex');
            pendingOAuthStates.set(state, now);
            res.redirect(302, this.googleAuthService.getAuthUrl(state));
        });

        app.get('/auth/callback', async (req, res) => {
            const googleError = typeof req.query.error === 'string' ? req.query.error : '';
            if (googleError) {
                res.status(400).type('text').send('Google authorization was cancelled or denied: ' + googleError);
                return;
            }

            const code = typeof req.query.code === 'string' ? req.query.code : '';
            const state = typeof req.query.state === 'string' ? req.query.state : '';
            const createdAt = pendingOAuthStates.get(state);
            if (!code || !state || !createdAt || Date.now() - createdAt > 10 * 60 * 1000) {
                res.status(400).type('text').send('This OAuth session is invalid or expired. Open /auth and start again.');
                return;
            }
            pendingOAuthStates.delete(state);

            if (!this.googleAuthService) {
                res.status(503).type('text').send('Google OAuth is unavailable in mock mode.');
                return;
            }

            try {
                const tokens = await this.googleAuthService.handleCallback(code, state);
                if (!tokens.refresh_token) {
                    res.status(500).type('text').send('Google did not return a refresh token. Revoke this app in your Google Account permissions, then retry OAuth setup.');
                    return;
                }
                const refreshTokenHtml = tokens.refresh_token
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
                res.type('html').send(
                    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                    '<title>Google authorization complete</title></head><body style="font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px">' +
                    '<h1>Google authorization successful</h1><p>The service has received the refresh token. To preserve authentication across Render redeploys, add this value as the <b>GOOGLE_REFRESH_TOKEN</b> environment variable in Render.</p>' +
                    '<p><b>Keep this token private.</b> Do not send it in chat or commit it to GitHub.</p><textarea readonly style="width:100%;min-height:90px;box-sizing:border-box;padding:12px">' +
                    refreshTokenHtml + '</textarea><p>Open Render Dashboard → your service → Environment, add <code>GOOGLE_REFRESH_TOKEN</code>, save changes, then return to the service logs to confirm it restarts.</p>' +
                    '</body></html>'
                );
            } catch (error) {
                logger.error('Hosted Google OAuth callback failed:', error);
                res.status(500).type('text').send(
                    'Google authorization failed. Open /auth and retry. Check Render application logs for the error details.'
                );
            }
        });

        app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await this.server.connect(transport);
        app.all('/mcp', async (req, res) => {
            // Require a shared bearer token for every remote MCP request.
            // Configure MCP_AUTH_TOKEN in the hosting environment; never expose the endpoint unauthenticated.
            const configuredToken = process.env.MCP_AUTH_TOKEN;
            const authorization = req.header('authorization') || '';
            const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
            if (!configuredToken) {
                res.status(503).json({ error: 'MCP endpoint is not configured securely. Set MCP_AUTH_TOKEN in the service environment.' });
                return;
            }
            const supplied = Buffer.from(suppliedToken);
            const expected = Buffer.from(configuredToken);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Unauthorized' });
                return;
            }
            try {
                await transport.handleRequest(req, res, req.body);
            } catch (error) {
                logger.error('HTTP MCP request failed:', error);
                if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
            }
        });
        await new Promise<void>((resolve, reject) => {
            const httpServer = app.listen(port, '0.0.0.0', () => {
                logger.info(`MCP HTTP server listening on port ${port}`);
                resolve();
            });
            httpServer.on('error', reject);
        });
        return new Promise<void>(() => {});
    }
    
    async stop(): Promise<void> {
        logger.info('Stopping MCP server...');
    }
}