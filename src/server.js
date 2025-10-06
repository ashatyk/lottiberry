// server.mjs
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createWriteStream, createReadStream } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// Подключи свои реализации:
import { lottieToVideo as renderSingle } from './lottie-to-video.js';
import { lottieToVideoParallel as renderParallel } from './lottie-to-video-parallel.js';

const fastify = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
await fastify.register(cors, { origin: true });
await fastify.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

const TMP = await fs.mkdtemp(join(os.tmpdir(), 'lottiberry-svc-'));
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);

const jobs = new Map();

let running = 0;

fastify.get('/health', async () => ({ ok: true }));

fastify.post('/render', async (req, reply) => {
    const id = randomUUID();
    const jobDir = join(TMP, id);
    await fs.mkdir(jobDir, { recursive: true });
    const outPath = join(jobDir, 'out.mp4');

    let mode = 'parallel';
    let input;
    let opts = {};

    if (req.isMultipart()) {
        const parts = req.parts();
        const fields = {};
        for await (const p of parts) {
            if (p.type === 'file' && p.fieldname === 'file') {
                const inPath = join(jobDir, 'input.json');
                await streamToFile(p.file, inPath);
                input = inPath;
            } else if (p.type === 'field') {
                fields[p.fieldname] = p.value;
            }
        }
        mode = (fields.mode === 'single' || fields.mode === 'parallel') ? fields.mode : 'parallel';
        opts = decodeOpts(fields);
    } else {
        const body = req.body ?? {};
        mode = (body.mode === 'single' || body.mode === 'parallel') ? body.mode : 'parallel';
        input = body.input;
        opts = decodeOpts(body);
    }

    if (!input) return reply.code(400).send({ error: 'missing input' });

    const now = Date.now();
    const job = {
        id,
        status: 'queued',
        mode,
        input,
        opts,
        outPath,
        error: null,
        tQueued: now,
        tStart: null,
        tEnd: null,
    };
    jobs.set(id, job);
    schedule();
    return reply.code(202).send({ id, status: job.status });
});

fastify.get('/jobs/:id', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    const renderMs = job.tStart && job.tEnd ? job.tEnd - job.tStart : null;
    const totalMs = job.tQueued && job.tEnd ? job.tEnd - job.tQueued : null;
    return {
        id: job.id,
        status: job.status,
        mode: job.mode,
        error: job.error,
        timings: {
            queuedAt: job.tQueued ? new Date(job.tQueued).toISOString() : null,
            startedAt: job.tStart ? new Date(job.tStart).toISOString() : null,
            endedAt: job.tEnd ? new Date(job.tEnd).toISOString() : null,
            renderMs,
            totalMs,
        },
    };
});

fastify.get('/jobs/:id/result', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    if (job.status !== 'done') return reply.code(409).send({ error: 'not ready' });

    const renderMs = job.tStart && job.tEnd ? job.tEnd - job.tStart : null;
    const totalMs = job.tQueued && job.tEnd ? job.tEnd - job.tQueued : null;

    reply.header('Content-Type', 'video/mp4');
    reply.header('Content-Disposition', `attachment; filename="${job.id}.mp4"`);
    if (renderMs != null) reply.header('X-Render-Duration-Ms', String(renderMs));
    if (totalMs != null) reply.header('X-Total-Duration-Ms', String(totalMs));
    if (job.tStart) reply.header('X-Started-At', new Date(job.tStart).toISOString());
    if (job.tEnd) reply.header('X-Ended-At', new Date(job.tEnd).toISOString());
    reply.header('X-Mode', job.mode);

    return reply.send(createReadStream(job.outPath));
});

fastify.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });

// ---------------- internals ----------------
function schedule() {
    while (running < CONCURRENCY) {
        const next = [...jobs.values()].find(j => j.status === 'queued');
        if (!next) break;
        runJob(next).catch(() => {}).finally(() => schedule());
    }
}

async function runJob(job) {
    running++;
    job.status = 'running';
    job.tStart = Date.now();
    try {
        const common = {
            input: job.input,
            outPath: job.outPath,
            width: job.opts.width,
            height: job.opts.height,
            fps: job.opts.fps,
            bgColor: job.opts.bgColor,
            crf: job.opts.crf,
            preset: job.opts.preset,
            gop: job.opts.gop,
            threads: job.opts.threads,
            extraFfmpegArgs: job.opts.extraFfmpegArgs,
        };
        if (job.mode === 'single') {
            await renderSingle(common);
        } else {
            await renderParallel({ ...common, workers: job.opts.workers });
        }
        job.status = 'done';
    } catch (e) {
        job.status = 'error';
        job.error = String((e && e.message) || e);
        try { await fs.rm(job.outPath, { force: true }); } catch {}
    } finally {
        job.tEnd = Date.now();
        running--;
    }
}

function decodeOpts(src) {
    const n = (k) => src[k] != null ? Number(src[k]) : undefined;
    const s = (k) => src[k] != null ? String(src[k]) : undefined;
    const j = (k) => { try { return src[k] != null ? JSON.parse(src[k]) : undefined; } catch { return undefined; } };
    return {
        width: n('width'),
        height: n('height'),
        fps: n('fps'),
        bgColor: s('bgColor'),
        crf: n('crf'),
        preset: s('preset'),
        gop: n('gop'),
        threads: n('threads'),
        workers: n('workers'),
        extraFfmpegArgs: j('extraFfmpegArgs'),
    };
}

function streamToFile(readable, path) {
    return new Promise((res, rej) => {
        const ws = createWriteStream(path);
        readable.pipe(ws);
        ws.on('finish', res);
        ws.on('error', rej);
    });
}
