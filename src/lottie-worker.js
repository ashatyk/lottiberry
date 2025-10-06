import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from 'canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';

const { dataStr, W, H, bgColor, indices, wasmPath } = workerData;

if (wasmPath) {
    DotLottie.setWasmUrl(`file://${wasmPath}`);
}

const canvas = createCanvas(W, H);

const player = new DotLottie({
    canvas,
    autoplay: false,
    loop: false,
    data: dataStr,
    useFrameInterpolation: true,
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
