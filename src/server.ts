import Fastify from 'fastify';
import cors from '@fastify/cors';
import { promises as fs, createReadStream } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { renderLottie } from './render-lottie.js';
import { type TDecodeOptions, decodeOptions } from './decode-options.js';

type RenderBody = {
    input?: string | Record<string, unknown>;
} & TDecodeOptions;

class Limiter {
    private running = 0;
    constructor(private readonly limit: number) {}
    try(): boolean {
        if (this.running >= this.limit) return false;
        this.running++;
        return true;
    }
    release(): void {
        if (this.running > 0) this.running--;
    }
}

const fastify = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
await fastify.register(cors, { origin: true });

const TMP_ROOT = await fs.mkdtemp(join(os.tmpdir(), 'lottiberry-svc-'));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? '1'));
const limiter = new Limiter(CONCURRENCY);

fastify.get('/health', async () => ({ ok: true }));

fastify.post<{ Body: RenderBody }>('/render', async (req, reply) => {
    const body = (req.body ?? {}) as RenderBody;
    const input = body.input;
    if (!input) return reply.code(400).send({ error: 'missing input' });

    if (!limiter.try()) return reply.code(429).send({ error: 'busy' });

    const opts = decodeOptions(body);
    const dir = await fs.mkdtemp(join(TMP_ROOT, 'job-'));
    const outPath = join(dir, 'out.mp4');

    try {
        await renderLottie({
            input,
            outPath,
            bgColor: opts.bgColor,
            crf: opts.crf,
            preset: opts.preset,
            threads: opts.threads,
            workers: opts.workers,
            extraFfmpegArgs: opts.extraFfmpegArgs,
        });

        reply
            .type('video/mp4')
            .header('Content-Disposition', 'inline; filename="out.mp4"')
            .header('Cache-Control', 'no-store')
            .header('X-Mode', 'parallel')

        const rs = createReadStream(outPath);
        const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

        rs.once('close', cleanup);
        rs.once('error', cleanup);
        reply.raw.once('close', cleanup);
        reply.raw.once('error', cleanup);

        return reply.send(rs);
    } catch (e) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: msg });
    } finally {
        limiter.release();
    }
});

fastify.addHook('onClose', async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

await fastify.listen({
    port: Number(process.env.PORT ?? 3000),
    host: '0.0.0.0',
});
