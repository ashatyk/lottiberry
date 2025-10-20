import ffmpegStatic from 'ffmpeg-static';
import { createRequire } from 'node:module';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join as pjoin } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Writable } from 'node:stream';

const require = createRequire(import.meta.url);

type TLottieInput = string | Record<string, unknown> | unknown;

interface ILottieMeta {
    w?: number;
    h?: number;
    ip?: number;
    op?: number;
    fr?: number;
    fps?: number;
    totalFrames?: number;
}

interface IParams {
    input: TLottieInput;
    outPath: string;
    bgColor?: string;
    crf?: number;
    preset?: string;
    threads?: number;
    workers?: number;
    extraFfmpegArgs?: string[];
}

export async function renderLottie({
   input,
   outPath,
   bgColor = '#000000',
   crf = 18,
   preset = 'veryfast',
   threads,
   workers: workersIn,
   extraFfmpegArgs = [],
}: IParams): Promise<void> {
    if (!outPath) throw new Error('outPath is required');

    const dataStr = await toJsonString(input);
    const meta = safeParseMeta(dataStr);

    const W = Math.max(0, meta.w ?? 0);
    const H = Math.max(0, meta.h ?? 0);

    const ip = Number.isFinite(meta.ip) ? Number(meta.ip) : 0;
    const op = Number.isFinite(meta.op) ? Number(meta.op) : (meta.totalFrames ?? 0);
    const nSrc = Math.max(0, Math.ceil(op - ip));

    const srcFps = meta.fr ?? meta.fps ?? 30;
    const FPS = clampInt(Math.round(srcFps), 1, 240);

    const dataPath = pjoin(tmpdir(), `lottie-${Date.now()}-${rand()}.json`);
    await writeFile(dataPath, dataStr);

    const ffArgs = buildFfmpegArgs({
        W,
        H,
        FPS,
        preset,
        crf,
        threads: threads ?? 1,
        extra: extraFfmpegArgs,
        outPath,
    });

    const ff = spawn(resolveFfmpegPath(), ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    
    ff.on('error', (e: Error) => { throw new Error(e.message); });
    
    const stdin = ff.stdin as Writable;

    const cpuCount = Math.max(1, cpus().length);
    const workerCount = Math.max(1, Math.min(workersIn ?? Math.min(cpuCount - 1, 8), nSrc || 1));

    const frameIndices = Array.from({ length: nSrc }, (_, i) => i);
    const chunks = chunkArray(frameIndices, workerCount);
    const wasmPath = safeResolveWasm();

    const store = new Map<number, Buffer>();
    let nextToWrite = 0;
    let writing: Promise<void> = Promise.resolve();
    const lastIndex = nSrc - 1;

    const workerDone: Promise<void>[] = [];
    const workers = [];

    try {
        for (const indices of chunks) {
            const w = new (await import('node:worker_threads')).Worker(
                new URL('./lottie-worker.js', import.meta.url),
                { workerData: { dataPath, W, H, bgColor, indices, wasmPath } },
            );
            workers.push(w);

            const p = new Promise<void>((resolve, reject) => {
                w.on('message', (msg: { type: 'frame'; i: number; ab: ArrayBuffer } | { type: 'done' }) => {
                    if (msg.type === 'frame') {
                        const buf = Buffer.from(msg.ab);
                        store.set(msg.i, buf);

                        while (store.has(nextToWrite)) {
                            const b = store.get(nextToWrite)!;
                            store.delete(nextToWrite);
                            writing = writing.then(() => writeBuf(stdin, b));
                            nextToWrite = nextToWrite === lastIndex ? lastIndex + 1 : nextToWrite + 1;
                        }
                    } else if (msg.type === 'done') {
                        resolve();
                    }
                });
                w.on('error', reject);
                w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
            });

            workerDone.push(p);
        }

        await Promise.all(workerDone);
        await writing;

        stdin.end();
        await waitClose(ff);

    } finally {
        await safeUnlink(dataPath);
        store.clear();
        await Promise.allSettled(workers.map((w) => w.terminate()));
    }
}

function buildFfmpegArgs(opts: {
    W: number;
    H: number;
    FPS: number;
    preset: string;
    crf: number;
    threads: number;
    extra: string[];
    outPath: string;
}): string[] {
    const { W, H, FPS, preset, crf, threads, extra, outPath } = opts;

    const gop = String(FPS * 12);

    return [
        '-y',
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${W}x${H}`,
        '-framerate', String(FPS),
        '-i', 'pipe:0',
        '-an',
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-g', gop,
        '-threads', String(threads),
        ...(Array.isArray(extra) && extra.length ? extra : []),
        outPath,
    ];
}

function resolveFfmpegPath(): string {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    const sys = out.status === 0 ? out.stdout.split(/\r?\n/).find(Boolean) : null;
    if (sys) return sys;
    if (ffmpegStatic) return String(ffmpegStatic);
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function chunkArray<T>(arr: T[], k: number): T[][] {
    if (arr.length === 0) return [];

    const per = Math.ceil(arr.length / k);
    const out: T[][] = [];

    for (let j = 0; j < k; j++) {
        const s = j * per, e = Math.min(arr.length, s + per);
        if (s < e) out.push(arr.slice(s, e));
    }
    return out;
}

function rand(): string {
    return Math.random().toString(36).slice(2);
}

async function toJsonString(input: TLottieInput): Promise<string> {
    if (typeof input === 'string') {
        try {
            const txt = await readFile(input, 'utf8').catch(() => null);
            if (txt != null) return txt;
            JSON.parse(input);
            return input;
        } catch {
            return String(input);
        }
    }
    if (typeof input === 'object') return JSON.stringify(input);
    return String(input);
}

function safeParseMeta(json: string): ILottieMeta {
    try { return JSON.parse(json) as ILottieMeta; }
    catch { return {}; }
}

function clampInt(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v | 0));
}

function safeResolveWasm(): string | null {
    try { return require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm'); }
    catch { return null; }
}

function once(emitter: NodeJS.EventEmitter, ev: string): Promise<void> {
    return new Promise((r) => emitter.once(ev, r));
}

async function writeBuf(stream: Writable, buf: Buffer): Promise<void> {
    if (!stream.write(buf)) await once(stream, 'drain');
}

function waitClose(child: import('node:child_process').ChildProcess): Promise<void> {
    return new Promise((res, rej) => {
        child.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)));
    });
}

async function safeUnlink(path: string): Promise<void> {
    try { await unlink(path); } catch {}
}
