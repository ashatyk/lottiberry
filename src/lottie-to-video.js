import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import ffmpegStatic from 'ffmpeg-static';
import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);

export async function lottieToVideo({
    input,
    outPath,
    width,
    height,
    fps,
    bgColor = '#000000',
    codec = 'libx264',
    crf = 18,
    preset = 'medium'
} = {}) {
    const canvas = createCanvas(2, 2);

    const wasmPath = require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm');

    DotLottie.setWasmUrl(`file://${wasmPath}`);


    const dataStr = typeof input === 'string'
        ? await readFile(input, 'utf8')
        : JSON.stringify(input);

    const player = new DotLottie({
        canvas,
        autoplay: false,
        loop: false,
        data: dataStr,
        useFrameInterpolation: false,
        backgroundColor: bgColor,
        renderConfig: { autoResize: false, devicePixelRatio: 1 }
    });

    await once(player, 'ready');
    await once(player, 'load');

    const aSize = player.animationSize();
    const W = width  ?? aSize.width;
    const H = height ?? aSize.height;
    canvas.width = W;
    canvas.height = H;
    player.resize();

    const srcFps = Math.round(player.totalFrames / Math.max(player.duration, 1e-6));

    const FPS = fps ?? srcFps;

    const args = [
        '-y',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-s', `${W}x${H}`,
        '-r', String(FPS),
        '-i', 'pipe:0',
        '-an'
    ];

    if (codec === 'libvpx-vp9') {
        args.push('-c:v','libvpx-vp9','-b:v','0','-crf', String(crf));
    } else {
        args.push('-c:v','libx264','-crf', String(crf), '-preset', preset, '-pix_fmt','yuv420p','-movflags','+faststart');
    }
    args.push(outPath);

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
        const child = spawn(ffbin, args, { stdio: ['pipe','inherit','inherit'] });

        child.on('error', (e) => {
            throw new Error(`${e.message}`);
        });

        return child;
    }

    const ff = spawnFfmpeg(args);

    for (let f = 0; f < player.totalFrames; f++) {
        await renderFrame(player, f);
        ff.stdin.write(Buffer.from(player.buffer));
    }

    ff.stdin.end();

    await new Promise((res, rej) => {
        ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)));
    });
}

function once(emitter, type) {
    return new Promise((resolve) => {
        const h = () => { emitter.removeEventListener(type, h); resolve(); };
        emitter.addEventListener(type, h);
    });
}

function renderFrame(player, frameIndex) {
    return new Promise((resolve) => {
        const onRender = () => {
            player.removeEventListener('render', onRender);
            resolve();
        };
        player.addEventListener('render', onRender);
        player.setFrame(frameIndex);
    });
}
