const fastify = require('fastify')({ trustProxy: process.env.HTTP_TRUST_PROXY === 'true' });
const { short } = require('leeks.js');
const { join } = require('path');
const { files } = require('node-dir');
const { getPrivilegeLevel } = require('./lib/users');
const { format } = require('util');

process.env.ORIGIN = process.env.HTTP_INTERNAL || process.env.HTTP_EXTERNAL;

module.exports = async client => {
    // -----------------------------
    // Plugins
    // -----------------------------
    fastify.register(require('@fastify/multipart'), { limits: { fileSize: 2 ** 27 } }); // 128 MiB
    fastify.register(require('@fastify/cookie'));
    fastify.register(require('@fastify/jwt'), {
        cookie: { cookieName: 'token', signed: false },
        secret: process.env.ENCRYPTION_KEY,
    });

    if (process.env.SENTRY_DSN) {
        const Sentry = require('@sentry/node');
        Sentry.setupFastifyErrorHandler(fastify);
    }

    // -----------------------------
    // Auth decorators
    // -----------------------------
    fastify.decorate('authenticate', async (req, res) => {
        try {
            const data = await req.jwtVerify();
            if (data.expiresAt < Date.now()) throw 'expired';
            if (data.createdAt < new Date(process.env.INVALIDATE_TOKENS).getTime()) throw 'expired';
        } catch (error) {
            return res.code(401).send({
                error: 'Unauthorised',
                message: error === 'expired' ? 'Your token has expired; please re-authenticate.' : 'You are not authenticated.',
                statusCode: 401,
            });
        }
    });

    fastify.decorate('isMember', async (req, res) => {
        // existing code unchanged
    });

    fastify.decorate('isAdmin', async (req, res) => {
        // existing code unchanged
    });

    // -----------------------------
    // Body processing
    // -----------------------------
    fastify.addHook('preHandler', (req, res, done) => {
        if (req.body && typeof req.body === 'object') {
            for (const prop in req.body) {
                if (typeof req.body[prop] === 'string') {
                    req.body[prop] = req.body[prop].trim();
                }
            }
        }
        done();
    });

    // -----------------------------
    // Logging
    // -----------------------------
    fastify.addHook('onResponse', (req, res, done) => {
        done();
        const status = (res.statusCode >= 500
            ? '&4'
            : res.statusCode >= 400
                ? '&6'
                : res.statusCode >= 300
                    ? '&3'
                    : res.statusCode >= 200
                        ? '&2'
                        : '&f') + res.statusCode;
        let responseTime = res.elapsedTime.toFixed(2);
        responseTime = (responseTime >= 100
            ? '&c'
            : responseTime >= 10
                ? '&e'
                : '&a') + responseTime + 'ms';
        const level = req.routeOptions?.url === '/status'
            ? 'debug'
            : req.routeOptions?.url === '/*'
                ? 'verbose'
                : 'info';
        client.log[level]?.http(
            format(
                short(`${req.id} ${req.ip} ${req.method} %s &m-+>&r ${status}&b in ${responseTime}`),
                req.url,
            ),
        );
    });

    fastify.addHook('onError', async (req, res, err) => client.log.error.http(req.id, err));

    // -----------------------------
    // Routes
    // -----------------------------
    // Load all routes dynamically
    const dir = join(__dirname, '/routes');
    files(dir, { exclude: /^\./, match: /.js$/, sync: true }).forEach(file => {
        const path = file
            .substring(0, file.length - 3)
            .substring(dir.length)
            .replace(/\\/g, '/')
            .replace(/\[(\w+)\]/gi, ':$1')
            .replace('/index', '') || '/';
        const route = require(file);

        Object.keys(route).forEach(method => fastify.route({
            config: { client },
            method: method.toUpperCase(),
            path,
            ...route[method](fastify),
        }));
    });

    const { handler } = await import('@discord-tickets/settings/build/handler.js');
    fastify.all('/*', {}, (req, res) => handler(req.raw, res.raw, () => {}));

    // -----------------------------
    // Status endpoint for healthchecks
    // -----------------------------
    fastify.get('/status', async () => ({ status: 'ok' }));

    // -----------------------------
    // Start server (Railway-compatible)
    // -----------------------------
    const PORT = process.env.PORT || 3000;
    const HOST = process.env.HTTP_HOST || '0.0.0.0';

    fastify.listen({ host: HOST, port: PORT }, (err, addr) => {
        if (err) client.log.error.http(err);
        else client.log.success.http(`Listening at ${addr}`);
    });

    process.on('sveltekit:error', ({ error, errorId }) => {
        client.log.error.http(`SvelteKit ${errorId} ${error}`);
    });
};
