// ESM
import express from "express";
import serverless from "serverless-http";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { lottieToVideo } from "./lottie-to-video.js";

const app = express();

app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (_, res) => res.json({ ok: true }));

// POST /src/index
// body: { lottieJson?:object, lottieUrl?:string, width?, height?, fps?, codec?, crf?, preset?, bgColor? }
app.post("/api/render", async (req, res) => {
    try {
        const {
            lottieJson,
            lottieUrl,
            width,
            height,
            fps,
            codec = "libx264",
            crf = 20,
            preset = "medium",
            bgColor = "#000000",
            ext, // "mp4" | "webm" (по codec)
        } = req.body || {};

        if (!lottieJson && !lottieUrl) {
            return res.status(400).json({ error: "Provide lottieJson or lottieUrl" });
        }

        const input =
            lottieJson ??
            (await (await fetch(lottieUrl, { cache: "no-store" })).text());

        const id = crypto.randomUUID();
        const outExt = ext || (codec === "libvpx-vp9" ? "webm" : "mp4");
        const outPath = path.join("/tmp", `out-${id}.${outExt}`);

        await lottieToVideo({
            input, outPath, width, height, fps, codec, crf, preset, bgColor,
        });

        // Отдаем файл и удаляем после отдачи
        res.setHeader("Content-Type", codec === "libvpx-vp9" ? "video/webm" : "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="animation.${outExt}"`);
        const stream = fs.createReadStream(outPath);
        stream.on("close", () => fs.promises.unlink(outPath).catch(() => {}));
        stream.pipe(res);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: String(e.message || e) });
    }
});

export default serverless(app);
