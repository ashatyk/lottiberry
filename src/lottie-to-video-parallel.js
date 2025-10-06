import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import ffmpegStatic from 'ffmpeg-static';
import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

export async function lottieToVideoParallel({
    input,
    outPath,
    width,
    height,
    fps,
    bgColor = '#000000',
    crf = 18,
    preset = 'veryfast',
    gop,
    threads,
    workers = Math.max(1, Math.min(os.cpus().length - 1, 8)),
    extraFfmpegArgs = [],
} = {}) {
    if (!outPath) throw new Error('outPath is required');

    const dataStr = typeof input === 'string'
        ? await readFile(input, 'utf8')
        : (typeof input === 'object' ? JSON.stringify(input) : String(input));

    const probeCanvas = createCanvas(2, 2);

    try {
        const wasmPath = require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm');
        DotLottie.setWasmUrl(`file://${wasmPath}`);
    } catch {}

    const probe = new DotLottie({
        canvas: probeCanvas,
        autoplay: false,
        loop: false,
        data: dataStr,
        useFrameInterpolation: false,
        backgroundColor: bgColor,
        renderConfig: { autoResize: false, devicePixelRatio: 1 },
    });

    await waitEvt(probe, 'ready');
    await waitEvt(probe, 'load');

    const aSize = probe.animationSize();
    const W = width  ?? aSize.width;
    const H = height ?? aSize.height;

    probeCanvas.width = W;
    probeCanvas.height = H;

    probe.resize();

    const srcFps = probe.fps ?? (probe.totalFrames / Math.max(probe.duration, 1e-6));
    const FPS = fps ?? Math.round(srcFps);
    const nSrc = probe.totalFrames;
    const totalOut = Math.max(1, Math.round(probe.duration * FPS));
    const ratio = FPS / srcFps;

    const repeats = new Uint16Array(nSrc);

    for (let k = 0; k < nSrc; k++) {
        repeats[k] = Math.max(0, Math.round((k + 1) * ratio) - Math.round(k * ratio));
    }
    const uniqueToRender = repeats.reduce((s, v) => s + (v > 0), 0);

    const args = [
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
        '-g', String(gop ?? FPS * 12),
    ];
    if (threads) args.push('-threads', String(threads));

    if (extraFfmpegArgs?.length) args.push(...extraFfmpegArgs);

    args.push(outPath);

    const ff = spawn(resolveFfmpegPath(), args, { stdio: ['pipe', 'inherit', 'inherit'] });

    ff.on('error', (e) => { throw new Error(e.message); });

    const srcList = [];
    for (let k = 0; k < nSrc; k++) {
        if (repeats[k] > 0) {
            srcList.push(k);
        }
    }

    const chunks = splitEven(srcList, Math.min(workers, srcList.length || 1));

    const wasmPath = safeResolveWasm();

    let nextSrcToWrite = srcList.length ? srcList[0] : 0;

    const firstSrc = nextSrcToWrite;
    const lastSrc = srcList.length ? srcList[srcList.length - 1] : -1;

    let produced = 0;
    let writtenOut = 0;

    const store = new Map();

    const all = chunks.map((indices, idx) => new Promise((resolve, reject) => {
        const w = new Worker(new URL('./lottie-worker.js', import.meta.url), {
            workerData: { dataStr, W, H, bgColor, indices, wasmPath }
        });

        w.on('message', ({ type, i, ab }) => {
            if (type === 'frame') {
                produced++;

                store.set(i, Buffer.from(ab));

                while (store.has(nextSrcToWrite)) {

                    const buf = store.get(nextSrcToWrite);
                    store.delete(nextSrcToWrite);
                    const rep = repeats[nextSrcToWrite];

                    for (let r = 0; r < rep; r++) {
                        const ok = ff.stdin.write(buf);

                        if (!ok) {
                            ff.stdin.once('drain', () => {});
                        }

                        writtenOut++;
                    }

                    nextSrcToWrite = nextSrcToWrite === lastSrc ? lastSrc + 1 : nextInList(srcList, nextSrcToWrite);
                }
            }
        });
        w.on('error', reject);

        w.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    }));

    await Promise.all(all);
    ff.stdin.end();

    await new Promise((res, rej) => ff.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`))));

    void probe;
}

function waitEvt(player, type) {
    return new Promise((resolve) => {
        const h = () => { player.removeEventListener(type, h); resolve(); };
        player.addEventListener(type, h);
    });
}

function resolveFfmpegPath() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    const sys = out.status === 0 ? out.stdout.split(/\r?\n/).find(Boolean) : null;
    if (sys) return sys;
    if (ffmpegStatic) return ffmpegStatic;
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function splitEven(arr, k) {
    const n = arr.length;
    if (n === 0) return Array.from({ length: k }, () => []);
    const base = Math.floor(n / k), rem = n % k;
    const res = [];
    let s = 0;
    for (let i = 0; i < k; i++) {
        const len = base + (i < rem ? 1 : 0);
        res.push(arr.slice(s, s + len));
        s += len;
    }
    return res;
}

function nextInList(list, cur) {
    const idx = list.indexOf(cur);
    return idx >= 0 && idx + 1 < list.length ? list[idx + 1] : cur + 1;
}

function safeResolveWasm() {
    try { return require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm'); }
    catch { return null; }
}
