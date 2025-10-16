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
        try {
            const userId = req.user.id;
            const guildId = req.params.guild;
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return res.code(404).send({ error: 'Not Found', message: 'The requested resource could not be found.', statusCode: 404 });

            const guildMember = await guild.members.fetch(userId);
            if (!guildMember) return res.code(403).send({ error: 'Forbidden', message: 'You are not permitted for this action.', statusCode: 403 });
        } catch (err) {
            res.send(err);
        }
    });

    fastify.decorate('isAdmin', async (req, res) => {
        try {
            const userId = req.user.id;
            const guildId = req.params.guild;
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return res.code(404).send({ error: 'Not Found', message: 'The requested resource could not be found.', statusCode: 404 });
            if (client.banned_guilds.has(guildId)) return res.code(451).send({ error: 'Unavailable For Legal Reasons', message: 'This guild has been banned for breaking the terms of service.', statusCode: 451 });

            if (!req.user.service && !req.user.scopes?.includes('applications.commands.permissions.update')) {
                return res.code(401).send({ elevate: 'admin', error: 'Unauthorised', message: 'Extra scopes required; reauthenticate.', statusCode: 401 });
            }

            const guildMember = await guild.members.fetch(userId);
            const isAdmin = await getPrivilegeLevel(guildMember) >= 2;
            if (!isAdmin) return res.code(403).send({ error: 'Forbidden', message: 'You are not permitted for this action.', statusCode: 403 });
        } catch (err) {
            res.send(err);
        }
    });

    // -----------------------------
    // Body processing
    // -----------------------------
    fastify.addHook('preHandler', (req, res, done) => {
        if (req.body && typeof req.body === 'object') {
            for (const prop in req.body) {
                if (typeof req.body[prop] === 'string') req.body[prop] = req.body[prop].trim();
            }
        }
        done();
    });

    // -----------------------------
    // Logging
    // -----------------------------
    fastify.addHook('onResponse', (req, res, done) => {
        done();
        const status = (res.statusCode >= 500 ? '&4' : res.statusCode >= 400 ? '&6' : res.statusCode >= 300 ? '&3' : res.statusCode >= 200 ? '&2' : '&f') + res.statusCode;
        let responseTime = res.elapsedTime?.toFixed(2) ?? '0.00';
        responseTime = (responseTime >= 100 ? '&c' : responseTime >= 10 ? '&e' : '&a') + responseTime + 'ms';
        const level = req.routeOptions?.url === '/status' ? 'debug' : req.routeOptions?.url === '/*' ? 'verbose' : 'info';
        client.log[level]?.http(format(short(`${req.id} ${req.ip} ${req.method} %s &m-+>&r ${status}&b in ${responseTime}`), req.url));
    });

    fastify.addHook('onError', async (req, res, err) => client.log.error.http(req.id, err));

    // -----------------------------
    // Routes
    // -----------------------------
    const dir = join(__dirname, '/routes');
    files(dir, { exclude: /^\./, match: /.js$/, sync: true }).forEach(file => {
        const path = file
            .substring(0, file.length - 3)
            .substring(dir.length)
            .replace(/\\/g, '/')
            .replace(/\[(\w+)\]/gi, ':$1')
            .replace('/index', '') || '/';

        if (path === '/status') return; // skip duplicate

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
    const PORT = process.env.PORT || process.env.HTTP_PORT || 3000;
    const HOST = process.env.HTTP_HOST || '0.0.0.0';

    fastify.listen({ host: HOST, port: PORT }, (err, addr) => {
        if (err) client.log.error.http(err);
        else client.log.success.http(`Listening at ${addr}`);
    });

    process.on('sveltekit:error', ({ error, errorId }) => {
        client.log.error.http(`SvelteKit ${errorId} ${error}`);
    });
};
