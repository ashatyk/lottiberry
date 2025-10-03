import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import ffmpegStatic from 'ffmpeg-static';
import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);

export async function lottieToVideo({
    input,                     // путь к .json или объект JSON
    outPath,                   // путь к .mp4 или .webm
    width, height,             // опц: размеры вывода; по умолчанию — исходные из лотти
    fps,                       // опц: FPS; по умолчанию — из лотти
    bgColor = '#000000',// фон; альфа в H.264/VP9 теряется, лучше задать фон
    codec = 'libx264',  // 'libx264' | 'libvpx-vp9'
    crf = 18,          // качество
    preset = 'medium'   // x264 пресет
} = {}) {
    // 1) Канвас
    const canvas = createCanvas(2, 2); // временно, поменяем после загрузки

    // 2) Ядро WASM для dotlottie-web (в Node надо указать путь)
    try {
        const wasmPath = require.resolve('@lottiefiles/dotlottie-web/dist/renderer.wasm');
        DotLottie.setWasmUrl(`file://${wasmPath}`);
    } catch { /* допустимо, если пакет сам найдёт wasm */ }

    // 3) Загрузка данных Lottie (.json строкой) без fetch/DOM
    const dataStr = typeof input === 'string'
        ? await readFile(input, 'utf8')
        : JSON.stringify(input);

    const player = new DotLottie({
        canvas,
        autoplay: false,
        loop: false,
        data: dataStr,
        useFrameInterpolation: false, // кадровая сетка как в AE
        backgroundColor: bgColor,
        renderConfig: { autoResize: false, devicePixelRatio: 1 }
    });

    // ждём готовности и загрузки
    await once(player, 'ready');
    await once(player, 'load');

    // размеры и fps из анимации
    const aSize = player.animationSize(); // { width, height }
    const W = width  ?? aSize.width;
    const H = height ?? aSize.height;
    canvas.width = W;
    canvas.height = H;
    player.resize();

    const srcFps = Math.round(player.totalFrames / Math.max(player.duration, 1e-6));

    const FPS = fps ?? srcFps;

    // 4) Запускаем ffmpeg и шлём сырые RGBA кадры по stdin
    const args = [
        '-y',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',      // буфер RGBA из dotlottie-web
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
        if (ffmpegStatic) return ffmpegStatic; // путь к бинарю из пакета
        // fallback: поиск в системе
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const out = spawnSync(cmd, ['ffmpeg'], { encoding: 'utf8' });
        const p = out.status === 0 ? out.stdout.split(/\r?\n/).find(Boolean) : null;
        return p || (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    }

    function spawnFfmpeg(args) {
        const ffbin = resolveFfmpegPath();
        const child = spawn(ffbin, args, { stdio: ['pipe','inherit','inherit'] });
        child.on('error', (e) => {
            throw new Error(
                `Не найден ffmpeg (${ffbin}). ` +
                `Установите ffmpeg или задайте переменную окружения FFMPEG_PATH. ` +
                `Оригинальная ошибка: ${e.message}`
            );
        });
        return child;
    }

    const ff = spawnFfmpeg(args);

    // 5) Рендерим покадрово
    for (let f = 0; f < player.totalFrames; f++) {
        // отрисовать кадр на canvas
        await renderFrame(player, f);

        // Uint8Array RGBA текущего кадра
        const rgba = Buffer.from(player.buffer);

        ff.stdin.write(rgba);
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
