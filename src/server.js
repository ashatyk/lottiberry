// server.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { lottieToVideo } from './lottie-to-video.js';
import { lottieToVideoParallel } from './lottie-to-video-parallel.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get('/health', async (_req, reply) => reply.send({ ok: true }));

app.post('/api/render', async (req, reply) => {
    try {
        const {
            lottieJson,
            lottieUrl,
            width,
            height,
            fps,
            crf = 20,
            preset = 'medium',
            bgColor = '#000000',
            ext,
        } = req.body || {};

        if (!lottieJson && !lottieUrl) {
            return reply.code(400).send({ error: 'Provide lottieJson or lottieUrl' });
        }

        const input =
            lottieJson ?? (await (await fetch(lottieUrl, { cache: 'no-store' })).text());

        const id = crypto.randomUUID();
        const outPath = path.join('/tmp', `out-${id}.mp4`);

        await lottieToVideo({
            input, outPath, width, height, fps, crf, preset, bgColor,
        });

        reply
            .header('Content-Type', 'video/mp4')
            .header('Content-Disposition', `attachment; filename="animation.mp4"`);

        const stream = fs.createReadStream(outPath);
        stream.on('close', () => fs.promises.unlink(outPath).catch(() => {}));
        return reply.send(stream);
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: String(e.message || e) });
    }
});


app.post('/api/render_parallel', async (req, reply) => {
    try {
        const {
            lottieJson,
            lottieUrl,
            width,
            height,
            fps,
            crf = 20,
            preset = 'medium',
            bgColor = '#000000',
            ext,
            workers,
        } = req.body || {};

        if (!lottieJson && !lottieUrl) {
            return reply.code(400).send({ error: 'Provide lottieJson or lottieUrl' });
        }

        const input = lottieJson ?? (await (await fetch(lottieUrl, { cache: 'no-store' })).text());

        const id = crypto.randomUUID();

        const outPath = path.join('/tmp', `out-${id}.mp4`);

        await lottieToVideoParallel({
            input, outPath, width, height, fps, crf, preset, bgColor, workers
        });

        reply
            .header('Content-Type', 'video/mp4')
            .header('Content-Disposition', `attachment; filename="animation.mp4"`);

        const stream = fs.createReadStream(outPath);
        stream.on('close', () => fs.promises.unlink(outPath).catch(() => {}));
        return reply.send(stream);
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: String(e.message || e) });
    }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

app.listen({ port, host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
});
