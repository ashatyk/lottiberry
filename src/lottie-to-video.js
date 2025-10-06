import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import ffmpegStatic from 'ffmpeg-static';
import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let RGB_SCRATCH = null;

export async function lottieToVideo({
    input,
    outPath,
    width,
    height,
    fps,
    bgColor = '#000000',
    codec = 'libx264',     // 'h264_nvenc' | 'h264_qsv' | 'h264_vaapi' | 'libvpx-vp9'
    crf = 18,
    preset = 'medium',
    gop,
    threads,
    extraFfmpegArgs = [],
} = {}) {
    if (!outPath) throw new Error('outPath is required');

    const canvas = createCanvas(2, 2);

    try {
        const wasmPath = require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm');
        DotLottie.setWasmUrl(`file://${wasmPath}`);
    } catch {}

    const dataStr = typeof input === 'string'
        ? await readFile(input, 'utf8')
        : (typeof input === 'object' ? JSON.stringify(input) : String(input));

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
        '-pix_fmt', 'rgb24',
        '-s', `${W}x${H}`,
        '-r', String(FPS),
        '-i', 'pipe:0',
        '-an',
    ];

    if (codec === 'libvpx-vp9') {
        args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf));
    } else {
        args.push('-c:v', codec, '-preset', preset, '-crf', String(crf));
        args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    }

    args.push('-g', String(gop ?? FPS * 2));

    if (threads) args.push('-threads', String(threads));
    if (extraFfmpegArgs.length) args.push(...extraFfmpegArgs);

    args.push(outPath);

    const ff = spawnFfmpeg(args);

    for (let i = 0; i < totalOut; i++) {
        const t = i / FPS;
        const srcIndex = Math.min(player.totalFrames - 1, Math.round(t * srcFps));
        await renderFrame(player, srcIndex);

        const u8 = player.buffer; // RGBA от рендерера
        RGB_SCRATCH = ensureRgbScratch(RGB_SCRATCH, W * H);
        packRGBAtoRGB(u8, RGB_SCRATCH);

        if (!ff.stdin.write(RGB_SCRATCH)) await onceEE(ff.stdin, 'drain');
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
    if (ffmpegStatic) return ffmpegStatic;
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
    const p = out.status === 0 ? out.stdout.split(/\r?\n/).find(Boolean) : null;
    return p || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

function spawnFfmpeg(args) {
    const ffbin = resolveFfmpegPath();
    const child = spawn(ffbin, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (e) => { throw new Error(e.message); });
    return child;
}

function ensureRgbScratch(buf, pixels) {
    const need = pixels * 3;
    if (!buf || buf.length !== need) return Buffer.allocUnsafe(need);
    return buf;
}

// RGBA -> RGB
function packRGBAtoRGB(src, dst) {
    for (let p = 0, q = 0; q < dst.length; p += 4, q += 3) {
        dst[q]   = src[p];
        dst[q+1] = src[p+1];
        dst[q+2] = src[p+2];
    }
}
