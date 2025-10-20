export type TDecodeOptions = {
    bgColor?: string;
    crf?: number;
    preset?: string;
    threads?: number;
    workers?: number;
    extraFfmpegArgs?: string[];
};

function isNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v);
}

function isString(v: unknown): v is string {
    return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(isString);
}

export function decodeOptions(src: Partial<Record<keyof TDecodeOptions, unknown>>): TDecodeOptions {
    const toNumber = (key: keyof TDecodeOptions): number | undefined => {
        const v = src[key];

        if (isNumber(v)) return v;

        if (isString(v)) {
            const num = Number(v);
            return Number.isFinite(num) ? num : undefined;
        }

        return undefined;
    };

    const toStringVal = (key: keyof TDecodeOptions): string | undefined => {
        const v = src[key];

        return v == null ? undefined : String(v);
    };

    const toStringArrayVal = (key: keyof TDecodeOptions): string[] | undefined => {
        const v = src[key];
        if (v == null) return undefined;

        if (isStringArray(v)) return v;

        if (isString(v)) {
            try {
                const arr = JSON.parse(v);
                return isStringArray(arr) ? arr : undefined;
            } catch {
                return undefined;
            }
        }
        return undefined;
    };

    return {
        bgColor: toStringVal('bgColor'),
        crf: toNumber('crf'),
        preset: toStringVal('preset'),
        threads: toNumber('threads'),
        workers: toNumber('workers'),
        extraFfmpegArgs: toStringArrayVal('extraFfmpegArgs'),
    };
}
