// Minimal declarations for untyped dependencies and globals.

declare module "tcadif/lib/ADIF" {
    /**
    A single logbook entry (ADIF field names).
    */
    export type Qso = Record<string, string>;

    // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors the library's export name
    export default class ADIF {
        constructor(options?: { qsos?: Qso[] });
        stringify(options?: {
            fieldDelim?: string;
            recordDelim?: string;
        }): string;
    }
}

/**
Options accepted by the opus-recorder global loaded from static/recorder.js.
*/
type RecorderConfig = {
    encoderApplication?: number;
    encoderFrameSize?: number;
    streamPages?: boolean;
    rawOpus?: boolean;
};

/**
The subset of the opus-recorder API used by this app.
*/
declare class Recorder {
    audioContext: AudioContext;
    recordingGainNode: GainNode;
    ondataavailable: (data: Uint8Array) => void;
    constructor(config?: RecorderConfig);
    start(): void;
    setRecordingGain(gain: number): void;
}
