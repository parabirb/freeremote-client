// Derived from https://github.com/Johni0702/web-audio-buffer-queue/tree/master
// ISC license

/* eslint-disable @typescript-eslint/no-deprecated --
ScriptProcessorNode is deprecated, but replacing it with an AudioWorklet would
change how audio is scheduled and played back. */

import extend from "extend";
import { Writable, type WritableOptions } from "readable-stream";

/**
A queued chunk of audio that knows how to copy itself into an AudioBuffer.
*/
type AudioBufferFormat = {
    /**
    Number of sample-frames (samples per channel) in this chunk.
    */
    readonly length: number;

    /**
    Copy samples from this chunk to the target AudioBuffer.

    @param to - The target audio buffer
    @param toOffset - Offset into the target audio buffer
    @param fromOffset - Offset into this chunk
    @param length - Amount of sample-frames to copy
    */
    copyTo(
        to: AudioBuffer,
        toOffset: number,
        fromOffset: number,
        length: number,
    ): void;
};

type RawChunk = Float32Array | Int16Array | Uint8Array;

type TypedArrayFormat = new (
    channels: number,
    isInterleaved: boolean,
    it: RawChunk,
) => AudioBufferFormat;

export type BufferQueueNodeOptions = WritableOptions & {
    /**
    Format of input data when not in objectMode.
    */
    dataType?: TypedArrayFormat;

    /**
    Whether the input data is interleaved.
    */
    isInterleaved?: boolean;

    /**
    Number of channels.
    */
    channels?: number;

    /**
    Buffer size, must be a power of two between 256 and 16384. 0 lets the
    browser pick a good value (recommended).
    */
    bufferSize?: number;

    /**
    The audio context the node is created in.
    */
    audioContext: AudioContext;
};

// Wraps an existing AudioBuffer.
export class AudioBufferBuffer implements AudioBufferFormat {
    constructor(private readonly it: AudioBuffer) {}

    get length() {
        return this.it.length;
    }

    copyTo(
        to: AudioBuffer,
        toOffset: number,
        fromOffset: number,
        length: number,
    ) {
        for (let channel = 0; channel < this.it.numberOfChannels; channel++) {
            const source = this.it.getChannelData(channel);
            to.copyToChannel(
                source.subarray(fromOffset, fromOffset + length),
                channel,
                toOffset,
            );
        }
    }
}

// Shared logic for interleaved/planar typed-array PCM chunks.
abstract class TypedArrayBuffer<
    T extends Float32Array | Int16Array,
> implements AudioBufferFormat {
    constructor(
        private readonly channels: number,
        private readonly isInterleaved: boolean,
        protected readonly it: T,
    ) {}

    get length() {
        return this.it.length / this.channels;
    }

    // Return the sample at the specified offset, normalised to a float.
    protected get(i: number): number {
        return this.it[i];
    }

    // Copy `length` samples into `to` (a single channel's data).
    protected bulkCopy(
        to: Float32Array,
        toOffset: number,
        fromOffset: number,
        length: number,
    ) {
        to.set(this.it.subarray(fromOffset, fromOffset + length), toOffset);
    }

    copyTo(
        to: AudioBuffer,
        toOffset: number,
        fromOffset: number,
        length: number,
    ) {
        for (let channel = 0; channel < this.channels; channel++) {
            const channelData = to.getChannelData(channel);
            if (this.isInterleaved && this.channels > 1) {
                // Interleaved data (L R L R ...) has to be de-interleaved
                // sample by sample
                for (let i = 0; i < length; i++) {
                    const actualFromOffset =
                        (fromOffset + i) * this.channels + channel;
                    channelData[toOffset + i] = this.get(actualFromOffset);
                }
            } else {
                // Planar data (or mono) can be copied in bulk; each channel
                // occupies one contiguous block of `this.length` samples
                const actualFromOffset = this.length * channel + fromOffset;
                this.bulkCopy(channelData, toOffset, actualFromOffset, length);
            }
        }
    }
}

export class Float32ArrayBuffer extends TypedArrayBuffer<Float32Array> {
    constructor(channels: number, isInterleaved: boolean, it: RawChunk) {
        let samples: Float32Array;
        if (it instanceof Float32Array) {
            samples = it;
        } else if (it instanceof Uint8Array) {
            // Raw bytes (e.g. a Node Buffer): reinterpret as 32-bit floats
            samples = new Float32Array(
                it.buffer,
                it.byteOffset,
                it.byteLength / 4,
            );
        } else {
            throw new TypeError(`Unsupported buffer type: ${String(it)}`);
        }

        super(channels, isInterleaved, samples);
    }
}

export class Int16ArrayBuffer extends TypedArrayBuffer<Int16Array> {
    constructor(channels: number, isInterleaved: boolean, it: RawChunk) {
        let samples: Int16Array;
        if (it instanceof Int16Array) {
            samples = it;
        } else if (it instanceof Uint8Array) {
            // Raw bytes (e.g. a Node Buffer): reinterpret as 16-bit integers
            samples = new Int16Array(
                it.buffer,
                it.byteOffset,
                it.byteLength / 2,
            );
        } else {
            throw new TypeError(`Unsupported buffer type: ${String(it)}`);
        }

        super(channels, isInterleaved, samples);
    }

    // Scale a signed 16-bit sample to the [-1, 1] range.
    protected override get(i: number): number {
        const value = this.it[i];
        return value / (2 ** 15 - (value > 0 ? 1 : 0));
    }

    protected override bulkCopy(
        to: Float32Array,
        toOffset: number,
        fromOffset: number,
        length: number,
    ) {
        // Integer samples must be converted one by one
        for (let i = 0; i < length; i++) {
            to[toOffset + i] = this.get(fromOffset + i);
        }
    }
}

/**
A source node that plays queued PCM buffers.

When no more data is queued, this node emits silence.

The queued buffers are played at the frequency of the audio context.

Multiple channels are supported, both interleaved and non interleaved layouts.
Every single buffer queued is expected to contain the same amount of samples
for every channel. Therefore a single frame may not be split across multiple
buffers.

When in object mode, the input format is determined automatically. Supported
formats are Float32Array, Int16Array and AudioBuffer. When not in object mode,
the input format has to be specified manually by passing
{@link Float32ArrayBuffer} or {@link Int16ArrayBuffer} as `dataType`.

Note that this does only implement a small part of the AudioNode interface.
This node will disconnect automatically when its stream is closed.
*/
export default class BufferQueueNode extends Writable {
    private readonly dataType: TypedArrayFormat;
    private readonly isObjectMode: boolean;
    private readonly isInterleaved: boolean;
    private readonly channels: number;
    // Chunks waiting to be played, oldest first.
    private readonly queue: AudioBufferFormat[] = [];
    private readonly node: ScriptProcessorNode;

    constructor(options: BufferQueueNodeOptions) {
        super(options);

        const settings = extend(
            {
                dataType: Float32ArrayBuffer,
                objectMode: false,
                isInterleaved: true,
                channels: 1,
                bufferSize: 0,
            },
            options,
        ) as Required<BufferQueueNodeOptions>;

        this.dataType = settings.dataType;
        this.isObjectMode = settings.objectMode;
        this.isInterleaved = settings.isInterleaved;
        const { channels, bufferSize, audioContext } = settings;
        this.channels = channels;

        // The script processor pulls samples from our queue whenever the
        // audio graph needs another block to play. The input count is 0, so
        // it is a pure generator
        const processorNode = audioContext.createScriptProcessor(
            bufferSize,
            0,
            channels,
        );

        let isShuttingDown = false;
        let isShutDown = false;
        // The chunk currently being played and our read position within it
        let currentBuffer: AudioBufferFormat | undefined;
        let currentBufferOffset = 0;

        processorNode.addEventListener("audioprocess", (event) => {
            if (isShutDown) {
                return;
            }

            const out = event.outputBuffer;
            // Write position in the output block
            let outOffset = 0;
            // Keep copying until the whole output block is filled
            while (outOffset < out.length) {
                // Pick up the next queued chunk if the previous one is used up
                if (!currentBuffer && this.queue.length > 0) {
                    currentBuffer = this.queue.shift();
                    currentBufferOffset = 0;
                }

                // Underrun: pad the rest of the block with silence
                if (!currentBuffer) {
                    for (let channel = 0; channel < channels; channel++) {
                        out.getChannelData(channel).fill(0, outOffset);
                    }

                    // The stream ended and the queue is drained: close
                    if (isShuttingDown) {
                        isShutDown = true;
                        queueMicrotask(() => {
                            this.emit("close");
                        });
                    }

                    break;
                }

                // Copy as much as fits in both the output and the chunk
                const remainingOutput = out.length - outOffset;
                const remainingInput =
                    currentBuffer.length - currentBufferOffset;
                const remaining = Math.min(remainingOutput, remainingInput);
                currentBuffer.copyTo(
                    out,
                    outOffset,
                    currentBufferOffset,
                    remaining,
                );
                currentBufferOffset += remaining;
                outOffset += remaining;

                // Chunk fully consumed; fetch the next one on the next pass
                if (currentBufferOffset >= currentBuffer.length) {
                    currentBuffer = undefined;
                }
            }
        });

        // Store node for later connecting
        this.node = processorNode;

        this.on("finish", () => {
            isShuttingDown = true;
        });
        this.on("close", () => {
            processorNode.disconnect();
        });
    }

    /**
    Connect this node to another node.

    @see https://developer.mozilla.org/en-US/docs/Web/API/AudioNode/connect(AudioNode)
    */
    connect(destination: AudioNode): AudioNode {
        return this.node.connect(destination);
    }

    /**
    Disconnect this node from another node.

    @see https://developer.mozilla.org/en-US/docs/Web/API/AudioNode/disconnect
    */
    disconnect(destination?: AudioNode): void {
        if (destination) {
            this.node.disconnect(destination);
        } else {
            this.node.disconnect();
        }
    }

    // Wrap the incoming chunk in the right format and append it to the queue.
    override _write(
        chunk: RawChunk | AudioBuffer,
        _encoding: string,
        // eslint-disable-next-line @typescript-eslint/no-restricted-types -- signature inherited from Writable
        callback: (error?: Error | null) => void,
    ) {
        let wrapped: AudioBufferFormat;
        if (this.isObjectMode) {
            // Object mode: detect the format from the chunk type
            if (chunk instanceof Float32Array) {
                wrapped = new Float32ArrayBuffer(
                    this.channels,
                    this.isInterleaved,
                    chunk,
                );
            } else if (chunk instanceof Int16Array) {
                wrapped = new Int16ArrayBuffer(
                    this.channels,
                    this.isInterleaved,
                    chunk,
                );
            } else {
                wrapped = new AudioBufferBuffer(chunk as AudioBuffer);
            }
        } else {
            // eslint-disable-next-line new-cap -- dataType is a class passed in by the caller
            wrapped = new this.dataType(
                this.channels,
                this.isInterleaved,
                chunk as RawChunk,
            );
        }

        this.queue.push(wrapped);
        callback();
    }
}
