import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import ffmpegStatic from 'ffmpeg-static';
import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);

export async function lottieToVideo({
    input,
    outPath,
    width,
    height,
    fps,
    bgColor = '#000000',
    crf = 18,
    preset = 'medium',
    gop,
    threads,
    extraFfmpegArgs = [],
} = {}) {
    if (!outPath) throw new Error('outPath is required');

    try {
        const wasmPath = require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm');
        DotLottie.setWasmUrl(`file://${wasmPath}`);
    } catch {}

    const dataStr = typeof input === 'string'
        ? await readFile(input, 'utf8')
        : (typeof input === 'object' ? JSON.stringify(input) : String(input));

    const canvas = createCanvas(2, 2);

    const player = new DotLottie({
        canvas,
        autoplay: false,
        loop: false,
        data: dataStr,
        useFrameInterpolation: false,
        backgroundColor: bgColor,
        renderConfig: { autoResize: false, devicePixelRatio: 1 },
    });

    await waitPlayer(player, 'ready');

    await waitPlayer(player, 'load');

    const aSize = player.animationSize();

    const W = width  ?? aSize.width;
    const H = height ?? aSize.height;

    canvas.width = W;
    canvas.height = H;

    player.resize();

    const srcFps = player.fps ?? (player.totalFrames / Math.max(player.duration, 1e-6));
    const FPS = fps ?? Math.round(srcFps);
    const totalOut = Math.max(1, Math.round(player.duration * FPS));

    const args = [
        '-y',
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${W}x${H}`,
        '-framerate', String(FPS),
        '-i', 'pipe:0',
        '-an',
    ];

    args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf));

    args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');

    args.push('-g', String(gop ?? FPS * 10));
    if (threads) args.push('-threads', String(threads));
    if (extraFfmpegArgs?.length) args.push(...extraFfmpegArgs);
    args.push(outPath);

    const ff = spawnFfmpeg(args);

    let sumSetFrame = 0;
    let sumWrite = 0;
    let sumDrain = 0;

    const tFrames0 = performance.now();
    let lastSrc = -1;
    let cachedBuf = null;
    let uniqueRenders = 0;

    for (let i = 0; i < totalOut; i++) {
        const tSec = i / FPS;
        const srcIndex = Math.min(player.totalFrames - 1, Math.round(tSec * srcFps));

        if (srcIndex !== lastSrc) {
            await renderFrame(player, srcIndex);
            uniqueRenders++;

            const u8 = player.buffer;
            cachedBuf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
            lastSrc = srcIndex;
        }

        const ok = ff.stdin.write(cachedBuf);
        if (!ok) {
            await onceEE(ff.stdin, 'drain');
        }

        if ((i + 1) % Math.max(1, Math.floor(FPS)) === 0 || i === totalOut - 1) {
            const elapsed = performance.now() - tFrames0;
            const fpsNow = 1000 * (i + 1) / Math.max(elapsed, 1);
        }
    }

    ff.stdin.end();

    await new Promise((res, rej) => {
        ff.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)));
    });
}

function waitPlayer(player, type) {
    return new Promise((resolve) => {
        const h = () => { player.removeEventListener(type, h); resolve(); };
        player.addEventListener(type, h);
    });
}

function renderFrame(player, frameIndex) {
    return new Promise((resolve) => {
        const onRender = () => { player.removeEventListener('render', onRender); resolve(); };
        player.addEventListener('render', onRender);
        player.setFrame(frameIndex);
    });
}

function onceEE(emitter, event) {
    return new Promise((resolve) => emitter.once(event, resolve));
}

function resolveFfmpegPath() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    // предпочитаем системный ffmpeg
    const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    const sys = out.status === 0 ? out.stdout.split(/\r?\n/).find(Boolean) : null;
    if (sys) return sys;
    // fallback: пакетный ffmpeg-static (если совместим)
    if (ffmpegStatic) return ffmpegStatic;
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function spawnFfmpeg(args) {
    const ffbin = resolveFfmpegPath();
    const child = spawn(ffbin, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (e) => { throw new Error(e.message); });
    return child;
}
