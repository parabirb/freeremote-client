// Acquired from https://www.arc.id.au/Spectrogram.html
//
// Vendored third-party code by Dr A.R. Collins, converted to TypeScript
// with its drawing logic left as-is. Currently unused by the UI (the
// waterfall canvas is commented out in +page.svelte).

/* eslint-disable max-params, unicorn/name-replacements, unicorn/consistent-boolean-name, @typescript-eslint/naming-convention, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/prefer-nullish-coalescing, unicorn/prefer-query-selector, unicorn/no-canvas-to-image --
Vendored third-party drawing code: these are style-only rules (parameter
count/names, truthiness checks, getElementById, getImageData/putImageData
line shifting) and "fixing" them risks changing rendering behaviour. */

/* =================================================================
  Filename: Spectrogram-2v01.js
  Rev: 2
  By: Dr A.R.Collins
  Description: JavaScript graphics functions to draw Spectrograms.

  Date    Description                                       By
  -------|----------------------------------------------------|---
  12Nov18 First beta                                           ARC
  17Nov18 Added offset into data buffer                        ARC
  08May19 this.imageURL URL added
          bugfix: fixed isNaN test
          Changed sgStart, sgStop to start, stop
          Added options object to constructors                 ARC
  10May19 Enabled Left to Right as well as Top to Bottom       ARC
  11May19 Added RasterscanSVG                                  ARC
  12May19 Added blankline for horizontal raster scans          ARC
  13May19 Eliminated unnecessary putImageData                  ARC
  14May19 Removed toDataURL, not used drawImage is better
          bugfix: SVG RHC names swapped                        ARC
  02Jun19 bugfix: startOfs not honored in horizontalNewLine    ARC
  03Jun19 Flipped the SVG and RHC names for waterfalls         ARC
  04Jun19 Unflip SVG and RHC for horizontal mode               ARC
          Swap "SVG" & "RHC" strings to match fn names         ARC
  05Jun19 bugfix: WaterfallSVG scrolling wrong way             ARC
  10Jun19 bugfix: support lineRate=0 for static display
          bugfix: ipBufPtr must be a ptr to a ptr              ARC
  11Jun19 Make ipBuffers an Array of Arrays, if lineRate=0
          use all buffers else use only ipBuffer[0]            ARC
  13Jun19 Use Waterfall and Rasterscan plus direction
          Use Boolean rather than string compare               ARC
  16Jun19 Use const and let                                    ARC
  20Jun19 Change order of parameters                           ARC
  21Jun19 Add setLineRate method                               ARC
  06Jul19 Released as Rev 1v00                                 ARC
  25Jul21 Refactor using class, arrow functions etc
          Added RasterImage object
          Use object.buffer as input not array of arrays       ARC
  25Jul21 Released as Rev 2v00                                 ARC
 ================================================================= */

/**
One colour-map entry: red, green, blue, alpha (each 0..255).
*/
type Rgba = [number, number, number, number];

/**
The data source: `buffer` holds one line of values (0..255 colour-map indices).
*/
export type SpectrogramInput = { buffer: ArrayLike<number> };

/**
Options are applied by name, case-insensitively (see `setProperty`).
*/
export type SpectrogramOptions = Record<string, unknown>;

type Direction = "up" | "down" | "left" | "right";

/**
Lower-case a direction string; anything unrecognised falls back to "down".
*/
function normaliseDirection(dir: unknown): string {
    return typeof dir === "string" ? dir.toLowerCase() : "down";
}

class Spectrogram {
    newLine: () => void;
    offScreenCvs: HTMLCanvasElement;
    setLineRate: (newRate: number) => void;
    clear: () => void;
    start: () => void;
    stop: () => void;

    /**
    Create a spectrogram drawing into an off-screen canvas.

     @param ipObj - Holder of the current input line
     @param w - Pixels per line
     @param h - Number of lines kept on screen
     @param sgMode - "WF" (scrolling waterfall) or "RS" (raster scan)
     @param rhc - Right-hand-coordinate flag; flips the scroll direction
     @param vert - True if lines are rows, false if they are columns
     @param options - Extra settings (lineRate, startBin, colorMap, ...)
     */
    constructor(
        ipObj: SpectrogramInput,
        w: number | undefined,
        h: number | undefined,
        sgMode: "WF" | "RS",
        rhc: boolean,
        vert: boolean,
        options?: SpectrogramOptions,
    ) {
        const opt = typeof options === "object" ? options : {}; // Avoid undeclared object errors
        const pxPerLine = w || 200;
        const lines = h || 200;
        const lineBuf = new ArrayBuffer(pxPerLine * 4); // 1 line
        const lineBuf8 = new Uint8ClampedArray(lineBuf);
        const lineImgData = new ImageData(lineBuf8, pxPerLine, 1); // 1 line of canvas pixels
        const blankBuf = new ArrayBuffer(pxPerLine * 4); // 1 line
        const blankBuf8 = new Uint8ClampedArray(blankBuf);
        const blankImgData = new ImageData(blankBuf8, pxPerLine, 1); // 1 line of canvas pixels
        const clearBuf = new ArrayBuffer(pxPerLine * lines * 4); // Fills with 0s ie. rgba 0,0,0,0 = transparent
        const clearBuf8 = new Uint8ClampedArray(clearBuf);
        let offScreenCtx: CanvasRenderingContext2D; // Offscreen canvas drawing context
        let clearImgData: ImageData;
        let lineRate = 30; // Requested line rate for dynamic waterfalls
        let interval = 0; // Msec
        let startOfs = 0;
        let nextLine = 0;
        let timerID: ReturnType<typeof setTimeout> | undefined;
        let isRunning = false;
        let sgTime = 0;
        let sgStartTime = 0;
        let demoCvsId: string | undefined; // Diagnostics only

        // Matlab Jet ref: stackoverflow.com grayscale-to-red-green-blue-matlab-jet-color-scale
        // prettier-ignore
        let colMap: Rgba[] = [
        [0, 0, 128, 255], [0, 0, 131, 255], [0, 0, 135, 255], [0, 0, 139, 255],
        [0, 0, 143, 255], [0, 0, 147, 255], [0, 0, 151, 255], [0, 0, 155, 255],
        [0, 0, 159, 255], [0, 0, 163, 255], [0, 0, 167, 255], [0, 0, 171, 255],
        [0, 0, 175, 255], [0, 0, 179, 255], [0, 0, 183, 255], [0, 0, 187, 255],
        [0, 0, 191, 255], [0, 0, 195, 255], [0, 0, 199, 255], [0, 0, 203, 255],
        [0, 0, 207, 255], [0, 0, 211, 255], [0, 0, 215, 255], [0, 0, 219, 255],
        [0, 0, 223, 255], [0, 0, 227, 255], [0, 0, 231, 255], [0, 0, 235, 255],
        [0, 0, 239, 255], [0, 0, 243, 255], [0, 0, 247, 255], [0, 0, 251, 255],
        [0, 0, 255, 255], [0, 4, 255, 255], [0, 8, 255, 255], [0, 12, 255, 255],
        [0, 16, 255, 255], [0, 20, 255, 255], [0, 24, 255, 255], [0, 28, 255, 255],
        [0, 32, 255, 255], [0, 36, 255, 255], [0, 40, 255, 255], [0, 44, 255, 255],
        [0, 48, 255, 255], [0, 52, 255, 255], [0, 56, 255, 255], [0, 60, 255, 255],
        [0, 64, 255, 255], [0, 68, 255, 255], [0, 72, 255, 255], [0, 76, 255, 255],
        [0, 80, 255, 255], [0, 84, 255, 255], [0, 88, 255, 255], [0, 92, 255, 255],
        [0, 96, 255, 255], [0, 100, 255, 255], [0, 104, 255, 255], [0, 108, 255, 255],
        [0, 112, 255, 255], [0, 116, 255, 255], [0, 120, 255, 255], [0, 124, 255, 255],
        [0, 128, 255, 255], [0, 131, 255, 255], [0, 135, 255, 255], [0, 139, 255, 255],
        [0, 143, 255, 255], [0, 147, 255, 255], [0, 151, 255, 255], [0, 155, 255, 255],
        [0, 159, 255, 255], [0, 163, 255, 255], [0, 167, 255, 255], [0, 171, 255, 255],
        [0, 175, 255, 255], [0, 179, 255, 255], [0, 183, 255, 255], [0, 187, 255, 255],
        [0, 191, 255, 255], [0, 195, 255, 255], [0, 199, 255, 255], [0, 203, 255, 255],
        [0, 207, 255, 255], [0, 211, 255, 255], [0, 215, 255, 255], [0, 219, 255, 255],
        [0, 223, 255, 255], [0, 227, 255, 255], [0, 231, 255, 255], [0, 235, 255, 255],
        [0, 239, 255, 255], [0, 243, 255, 255], [0, 247, 255, 255], [0, 251, 255, 255],
        [0, 255, 255, 255], [4, 255, 251, 255], [8, 255, 247, 255], [12, 255, 243, 255],
        [16, 255, 239, 255], [20, 255, 235, 255], [24, 255, 231, 255], [28, 255, 227, 255],
        [32, 255, 223, 255], [36, 255, 219, 255], [40, 255, 215, 255], [44, 255, 211, 255],
        [48, 255, 207, 255], [52, 255, 203, 255], [56, 255, 199, 255], [60, 255, 195, 255],
        [64, 255, 191, 255], [68, 255, 187, 255], [72, 255, 183, 255], [76, 255, 179, 255],
        [80, 255, 175, 255], [84, 255, 171, 255], [88, 255, 167, 255], [92, 255, 163, 255],
        [96, 255, 159, 255], [100, 255, 155, 255], [104, 255, 151, 255], [108, 255, 147, 255],
        [112, 255, 143, 255], [116, 255, 139, 255], [120, 255, 135, 255], [124, 255, 131, 255],
        [128, 255, 128, 255], [131, 255, 124, 255], [135, 255, 120, 255], [139, 255, 116, 255],
        [143, 255, 112, 255], [147, 255, 108, 255], [151, 255, 104, 255], [155, 255, 100, 255],
        [159, 255, 96, 255], [163, 255, 92, 255], [167, 255, 88, 255], [171, 255, 84, 255],
        [175, 255, 80, 255], [179, 255, 76, 255], [183, 255, 72, 255], [187, 255, 68, 255],
        [191, 255, 64, 255], [195, 255, 60, 255], [199, 255, 56, 255], [203, 255, 52, 255],
        [207, 255, 48, 255], [211, 255, 44, 255], [215, 255, 40, 255], [219, 255, 36, 255],
        [223, 255, 32, 255], [227, 255, 28, 255], [231, 255, 24, 255], [235, 255, 20, 255],
        [239, 255, 16, 255], [243, 255, 12, 255], [247, 255, 8, 255], [251, 255, 4, 255],
        [255, 255, 0, 255], [255, 251, 0, 255], [255, 247, 0, 255], [255, 243, 0, 255],
        [255, 239, 0, 255], [255, 235, 0, 255], [255, 231, 0, 255], [255, 227, 0, 255],
        [255, 223, 0, 255], [255, 219, 0, 255], [255, 215, 0, 255], [255, 211, 0, 255],
        [255, 207, 0, 255], [255, 203, 0, 255], [255, 199, 0, 255], [255, 195, 0, 255],
        [255, 191, 0, 255], [255, 187, 0, 255], [255, 183, 0, 255], [255, 179, 0, 255],
        [255, 175, 0, 255], [255, 171, 0, 255], [255, 167, 0, 255], [255, 163, 0, 255],
        [255, 159, 0, 255], [255, 155, 0, 255], [255, 151, 0, 255], [255, 147, 0, 255],
        [255, 143, 0, 255], [255, 139, 0, 255], [255, 135, 0, 255], [255, 131, 0, 255],
        [255, 128, 0, 255], [255, 124, 0, 255], [255, 120, 0, 255], [255, 116, 0, 255],
        [255, 112, 0, 255], [255, 108, 0, 255], [255, 104, 0, 255], [255, 100, 0, 255],
        [255, 96, 0, 255], [255, 92, 0, 255], [255, 88, 0, 255], [255, 84, 0, 255],
        [255, 80, 0, 255], [255, 76, 0, 255], [255, 72, 0, 255], [255, 68, 0, 255],
        [255, 64, 0, 255], [255, 60, 0, 255], [255, 56, 0, 255], [255, 52, 0, 255],
        [255, 48, 0, 255], [255, 44, 0, 255], [255, 40, 0, 255], [255, 36, 0, 255],
        [255, 32, 0, 255], [255, 28, 0, 255], [255, 24, 0, 255], [255, 20, 0, 255],
        [255, 16, 0, 255], [255, 12, 0, 255], [255, 8, 0, 255], [255, 4, 0, 255],
        [255, 0, 0, 255], [251, 0, 0, 255], [247, 0, 0, 255], [243, 0, 0, 255],
        [239, 0, 0, 255], [235, 0, 0, 255], [231, 0, 0, 255], [227, 0, 0, 255],
        [223, 0, 0, 255], [219, 0, 0, 255], [215, 0, 0, 255], [211, 0, 0, 255],
        [207, 0, 0, 255], [203, 0, 0, 255], [199, 0, 0, 255], [195, 0, 0, 255],
        [191, 0, 0, 255], [187, 0, 0, 255], [183, 0, 0, 255], [179, 0, 0, 255],
        [175, 0, 0, 255], [171, 0, 0, 255], [167, 0, 0, 255], [163, 0, 0, 255],
        [159, 0, 0, 255], [155, 0, 0, 255], [151, 0, 0, 255], [147, 0, 0, 255],
        [143, 0, 0, 255], [139, 0, 0, 255], [135, 0, 0, 255], [131, 0, 0, 255],
        [0, 0, 0, 0]
        ];

        const incrLine = () => {
            if ((vert && !rhc) || (!vert && rhc)) {
                nextLine++;
                if (nextLine >= lines) {
                    nextLine = 0;
                }
            } else {
                nextLine--;
                if (nextLine < 0) {
                    nextLine = lines - 1;
                }
            }
        };

        // Update dynamic waterfalls at a fixed rate
        const updateWaterfall = () => {
            // Grab latest line of data, write it to off screen buffer, inc 'nextLine'
            this.newLine();
            // Loop to write data at the desired rate, data is being updated asynchronously
            // ref for accurate timeout: https://www.sitepoint.com/creating-accurate-timers-in-javascript
            sgTime += interval;
            const sgDiff = Date.now() - sgStartTime - sgTime;
            if (isRunning) {
                timerID = setTimeout(updateWaterfall, interval - sgDiff);
            }
        };

        const setProperty = (propertyName: unknown, value: unknown) => {
            if (typeof propertyName !== "string" || value === undefined) {
                // Null is OK, forces default
                return;
            }

            switch (propertyName.toLowerCase()) {
                case "linerate": {
                    this.setLineRate(value as number); // SetLineRate does checks for number etc
                    break;
                }

                case "startbin": {
                    if (!Number.isNaN(Number(value)) && Number(value) > 0) {
                        startOfs = Number(value);
                    }

                    break;
                }

                case "onscreenparentid": {
                    if (
                        typeof value === "string" &&
                        document.getElementById(value)
                    ) {
                        demoCvsId = value;
                    }

                    break;
                }

                case "colormap": {
                    if (
                        Array.isArray(value) &&
                        Array.isArray(value[0]) &&
                        value[0].length === 4
                    ) {
                        colMap = value as Rgba[]; // Value must be an array of 4 element arrays to get here
                        if (colMap.length < 256) {
                            // Fill out the remaining colors with last color
                            for (let i = colMap.length; i < 256; i++) {
                                colMap[i] = colMap.at(-1)!;
                            }
                        }
                    }

                    break;
                }

                default: {
                    break;
                }
            }
        };

        const verticalNewLine = () => {
            if (sgMode === "WF") {
                if (rhc) {
                    // Shift the current display down 1 line, oldest line drops off
                    const temporaryImgData = offScreenCtx.getImageData(
                        0,
                        0,
                        pxPerLine,
                        lines - 1,
                    );
                    offScreenCtx.putImageData(temporaryImgData, 0, 1);
                } else {
                    // Shift the current display up 1 line, oldest line drops off
                    const temporaryImgData = offScreenCtx.getImageData(
                        0,
                        1,
                        pxPerLine,
                        lines - 1,
                    );
                    offScreenCtx.putImageData(temporaryImgData, 0, 0);
                }
            }

            const ipBuf8 = Uint8ClampedArray.from(ipObj.buffer);
            for (
                let opIdx = 0, ipIdx = startOfs;
                ipIdx < pxPerLine + startOfs;
                opIdx += 4, ipIdx++
            ) {
                const sigValue = ipBuf8[ipIdx] ?? 0; // If input line too short add zeros
                const rgba = colMap[sigValue]; // Array of rgba values
                lineBuf8[opIdx] = rgba[0]; // Red
                lineBuf8[opIdx + 1] = rgba[1]; // Green
                lineBuf8[opIdx + 2] = rgba[2]; // Blue
                lineBuf8[opIdx + 3] = rgba[3]; // Alpha
            }

            offScreenCtx.putImageData(lineImgData, 0, nextLine);
            if (sgMode !== "RS") {
                return;
            }

            incrLine();
            // If not static draw a white line in front of the current line to indicate new data point
            if (lineRate) {
                offScreenCtx.putImageData(blankImgData, 0, nextLine);
            }
        };

        const horizontalNewLine = () => {
            if (sgMode === "WF") {
                if (rhc) {
                    // Shift the current display right 1 line, oldest line drops off
                    const temporaryImgData = offScreenCtx.getImageData(
                        0,
                        0,
                        lines - 1,
                        pxPerLine,
                    );
                    offScreenCtx.putImageData(temporaryImgData, 1, 0);
                } else {
                    // Shift the current display left 1 line, oldest line drops off
                    const temporaryImgData = offScreenCtx.getImageData(
                        1,
                        0,
                        lines - 1,
                        pxPerLine,
                    );
                    offScreenCtx.putImageData(temporaryImgData, 0, 0);
                }
            }

            // Refresh the page image (it was just shifted)
            const pageImgData = offScreenCtx.getImageData(
                0,
                0,
                lines,
                pxPerLine,
            );
            // Clamp input values to 0..255 range unless the conversion is already done
            const ipBuf8 =
                ipObj.buffer instanceof Uint8Array
                    ? ipObj.buffer
                    : Uint8ClampedArray.from(ipObj.buffer);

            for (let ipIdx = 0; ipIdx < pxPerLine; ipIdx++) {
                const sigValue = ipBuf8[ipIdx + startOfs] ?? 0; // If input line too short add zeros
                const rgba = colMap[sigValue]; // Array of rgba values
                const opIdx = 4 * ((pxPerLine - ipIdx - 1) * lines + nextLine);
                pageImgData.data[opIdx] = rgba[0]; // Red
                pageImgData.data[opIdx + 1] = rgba[1]; // Green
                pageImgData.data[opIdx + 2] = rgba[2]; // Blue
                pageImgData.data[opIdx + 3] = rgba[3]; // Alpha
            }

            if (sgMode === "RS") {
                incrLine();
                // If not static draw a white line in front of the current line to indicate new data point
                if (lineRate) {
                    for (let j = 0; j < pxPerLine; j++) {
                        const opIdx =
                            4 *
                            ((rhc ? j : pxPerLine - j - 1) * lines + nextLine);
                        pageImgData.data[opIdx] = 255; // Red
                        pageImgData.data[opIdx + 1] = 255; // Green
                        pageImgData.data[opIdx + 2] = 255; // Blue
                        pageImgData.data[opIdx + 3] = 255; // Alpha
                    }
                }
            }

            offScreenCtx.putImageData(pageImgData, 0, 0);
        };

        const createOffScreenCanvas = () => {
            const cvs = document.createElement("canvas");
            if (vert) {
                cvs.setAttribute("width", String(pxPerLine)); // Reset canvas pixels width
                cvs.setAttribute("height", String(lines)); // Don't use style for this
                clearImgData = new ImageData(clearBuf8, pxPerLine, lines);
            } else {
                // Data written in columns
                cvs.setAttribute("width", String(lines)); // Reset canvas pixels width
                cvs.setAttribute("height", String(pxPerLine)); // Don't use style for this
                clearImgData = new ImageData(clearBuf8, lines, pxPerLine);
            }

            offScreenCtx = cvs.getContext("2d")!;

            return cvs;
        };

        // ===== now make the exposed properties and methods ===============

        this.newLine = vert ? verticalNewLine : horizontalNewLine; // Function pointers

        this.offScreenCvs = createOffScreenCanvas();

        this.setLineRate = function (newRate) {
            if (Number.isNaN(newRate) || newRate > 50 || newRate < 0) {
                console.error(
                    "invalid line rate [0 <= lineRate < 50 lines/sec]",
                );
                // Don't change the lineRate;
            } else if (newRate === 0) {
                // Static (one pass) raster
                lineRate = 0;
            } else {
                lineRate = newRate;
                interval = 1000 / lineRate; // Msec
            }
        };

        this.clear = function () {
            offScreenCtx.putImageData(clearImgData, 0, 0);
        };

        this.start = function () {
            sgStartTime = Date.now();
            sgTime = 0;
            isRunning = true;
            updateWaterfall(); // Start the update loop
        };

        this.stop = function () {
            isRunning = false;
            if (timerID) {
                clearTimeout(timerID);
            }

            // Reset where the next line is to be written
            if (sgMode === "RS") {
                if (vert) {
                    nextLine = rhc ? lines - 1 : 0;
                } else {
                    nextLine = rhc ? 0 : lines - 1;
                }
            } else {
                // WF
                nextLine = rhc ? 0 : lines - 1;
            }
        };

        // ===== set all the options  ================
        for (const [prop, value] of Object.entries(opt)) {
            setProperty(prop, value);
        }

        // Make a white line, it will show the input line for RS displays
        blankBuf8.fill(255);
        // Make a full canvas of the color map 0 values
        for (let i = 0; i < pxPerLine * lines * 4; i += 4) {
            clearBuf8[i] = colMap[0][0]; // Red
            clearBuf8[i + 1] = colMap[0][1]; // Green
            clearBuf8[i + 2] = colMap[0][2]; // Blue
            clearBuf8[i + 3] = colMap[0][3]; // Alpha
        }

        // For diagnostics only
        if (typeof demoCvsId === "string") {
            document.getElementById(demoCvsId)!.append(this.offScreenCvs);
        }

        // Initialize the direction and first line position
        this.stop();

        // Everything is set
        // if dynamic, wait for the start or newLine methods to be called
    }
}

/**
Scrolling spectrogram: new lines push older ones off the display.
*/
export class Waterfall extends Spectrogram {
    constructor(
        ipObject: SpectrogramInput,
        w?: number,
        h?: number,
        dir?: Direction | string,
        options?: SpectrogramOptions,
    ) {
        // [rhc, vert] per direction; unknown directions behave like "down"
        const flags: Record<string, [boolean, boolean]> = {
            up: [false, true],
            down: [true, true],
            left: [false, false],
            right: [true, false],
        };
        const [rhc, vert] = flags[normaliseDirection(dir)] ?? flags.down;
        super(ipObject, w, h, "WF", rhc, vert, options);
    }
}

/**
Raster scan: new lines overwrite the display in place, moving a marker line.
*/
export class Rasterscan extends Spectrogram {
    constructor(
        ipObject: SpectrogramInput,
        w?: number,
        h?: number,
        dir?: Direction | string,
        options?: SpectrogramOptions,
    ) {
        // [rhc, vert] per direction; unknown directions behave like "down"
        const flags: Record<string, [boolean, boolean]> = {
            up: [true, true],
            down: [false, true],
            left: [false, false],
            right: [true, false],
        };
        const [rhc, vert] = flags[normaliseDirection(dir)] ?? flags.down;
        super(ipObject, w, h, "RS", rhc, vert, options);
    }
}

/**
 Render a static image from `dataBuf` (one array per row, values are
 0..255 indices into the colour map) and return it as a canvas.
 
 Originally a class whose constructor returned the canvas; a plain
 function expresses the same thing in a type-safe way.
 */
export function createRasterImage(
    dataBuf: Array<ArrayLike<number>>,
    cols: number,
    rows: number,
    options: SpectrogramOptions = {},
): HTMLCanvasElement {
    const ipObject: SpectrogramInput = { buffer: [] };
    const dirs = ["up", "down", "left"];
    let direction = "down";
    let dirLC: string | undefined;

    if (typeof options.dir === "string") {
        dirLC = options.dir.toLowerCase();
    } else if (typeof options.direction === "string") {
        dirLC = options.direction.toLowerCase();
    }

    if (dirLC && dirs.includes(dirLC)) {
        direction = dirLC;
    }

    // DataBuf values are each an index (0..255) into a colorMap
    // Each of 256 colorMap entries holds the 4 values RGBA each (0..255) of a color

    // Force static image
    options.lineRate = 0;
    const raster = new Rasterscan(ipObject, cols, rows, direction, options);

    // Now build a raster display line by line
    for (let r = 0; r < rows; r++) {
        ipObject.buffer = dataBuf[r]!;
        raster.newLine();
    }

    return raster.offScreenCvs;
}
