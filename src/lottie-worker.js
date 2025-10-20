// lottie-worker.js (ESM)
import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import { readFile } from 'node:fs/promises';

const { dataPath, W, H, bgColor, indices, wasmPath } = workerData;
const dataStr = await readFile(dataPath, 'utf8');

if (wasmPath) DotLottie.setWasmUrl(`file://${wasmPath}`);

let canvas = createCanvas(W, H);
let ctx = canvas.getContext('2d');

let player = new DotLottie({
    canvas,
    autoplay: false,
    loop: false,
    data: dataStr,
    useFrameInterpolation: false,
    backgroundColor: bgColor,
    renderConfig: { autoResize: false, devicePixelRatio: 1 },
});

await once('ready');
await once('load');

canvas.width = W;
canvas.height = H;
player.resize();

for (const i of indices) {
    await renderFrame(i);
    const u8 = player.buffer;
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteLength + u8.byteOffset);
    parentPort.postMessage({ type: 'frame', i, ab }, [ab]);
}

player.destroy();

player = null;

canvas = null;

ctx = null;

parentPort.postMessage({ type: 'done' });

function once(type) {
    return new Promise((resolve) => {
        const h = () => { player.removeEventListener(type, h); resolve(); };
        player.addEventListener(type, h);
    });
}

function renderFrame(frameIndex) {
    return new Promise((resolve) => {
        const onRender = () => { player.removeEventListener('render', onRender); resolve(); };
        player.addEventListener('render', onRender);
        player.setFrame(frameIndex);
    });
}
