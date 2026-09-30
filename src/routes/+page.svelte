<script lang="ts">
    // Deps
    import saveAs from "file-saver";
    import { untrack } from "svelte";
    import { io } from "socket.io-client";
    import ADIF, { type Qso } from "tcadif/lib/ADIF";
    import { fade } from "svelte/transition";
    import { OpusDecoder } from "opus-decoder";
    import BufferQueueNode from "$lib/queue";
    import type {
        Bands,
        LoginInfo,
        Mode,
        RemoteSocket,
        RemoteState,
    } from "$lib/protocol";

    function clamp(value: number, min: number, max: number) {
        return Math.min(Math.max(value, min), max);
    }

    function avg(values: Iterable<number> & { readonly length: number }) {
        let sum = 0;
        for (const value of values) {
            sum += value;
        }

        return sum / values.length;
    }

    const modes: Record<Mode, string> = {
        voice: "Voice",
        ft8: "FT8",
        psk31: "PSK31",
    };

    // The sliding windows below smooth the meters: the S-meter averages the
    // last 25 readings and the SWR meter the last 10.
    const dbmWindow = 25;
    const swrWindow = 10;
    // The queue node is recreated this often to shed accumulated latency
    const queueResetIntervalMs = 120 * 1000;

    // State vars
    // "disconnected" shows the key upload screen, "connecting" a spinner and
    // "connected" the control panel. Set by the socket handlers below.
    let status = $state<"disconnected" | "connecting" | "connected">(
        "disconnected",
    );
    // Latest radio state pushed by the server
    let remoteState = $state<RemoteState>();
    let files = $state<FileList | null>();
    // Each toast needs a unique id so it can be keyed in the {#each}
    const errors = $state<{ id: number; message: string }[]>([]);
    let nextErrorId = 0;
    let dbm = $state(0);
    const dbmList = $state([0]);
    let pwr = $state(0);
    const swrList = $state([0]);
    const swr = $derived(avg(swrList));
    // Created by the "Enable microphone" click: browsers only allow audio
    // contexts and microphone access after a user gesture.
    let context = $state<AudioContext>();
    let micGain = $state(1);
    let outputGain = $state(1);
    let micLevel = $state(0);
    let clipping = $state(false);
    let recorder: Recorder | undefined;
    // S-meter text from the averaged dBm: S1..S9 in 6 dB steps from -127 dBm,
    // then "S9+N" above that.
    const sunits = $derived.by(() => {
        const average = avg(dbmList);
        return average > 79
            ? `S9+${average - 73}`
            : `S${Math.round(clamp((average + 127) / 6, 1, 9))}`;
    });
    let socket: RemoteSocket | undefined;
    let bands = $state<Bands>({});
    // Name of the band that contains the current frequency (empty if none)
    const currentBand = $derived.by(() => {
        if (!remoteState) {
            return "";
        }

        const { frequency } = remoteState;
        return (
            Object.keys(bands).find((key) => {
                const [low, high] = bands[key]!.edges;
                return low <= frequency && high > frequency;
            }) ?? ""
        );
    });
    let clubName = $state("");
    let clubEmail = $state("");
    let logbook = $state<Qso[]>([]);
    let outputGainNode: GainNode | undefined;
    let logCallsign = $state("");
    let logTime = $state("");
    let logRstTx = $state("");
    let logRstRx = $state("");
    // Displayed after the SWR meter; above 50 the reading is treated as infinite
    const swrText = $derived(
        swr > 50 ? "∞" : 1 + Math.floor((swr / 11) * 0.5 * 10) / 10,
    );

    // Frequencies are sent in 10 Hz units; the digit at `position` (1 = 10 Hz)
    function frequencyDigit(position: number) {
        const digit = Math.floor(
            ((remoteState?.frequency ?? NaN) % 10 ** position) /
                10 ** (position - 1),
        );
        return Number.isNaN(digit) ? 0 : digit;
    }

    function changeFrequency(delta: number) {
        if (remoteState) {
            socket?.emit("frequency", remoteState.frequency + delta);
        }
    }

    function selectBand(band: string) {
        const target = bands[band]!;
        // Jump to the band's default frequency for the current mode
        if (remoteState?.mode === "voice") {
            socket?.emit("frequency", target.voice[0]!);
        } else if (remoteState?.mode === "psk31") {
            socket?.emit("frequency", target.psk31);
        } else {
            socket?.emit("frequency", target.ft8);
        }

        // Close the daisyUI dropdown, which stays open while focused
        (document.activeElement as HTMLElement | null)?.blur();
    }

    function pushError(message: string) {
        errors.unshift({ id: nextErrorId++, message });
    }

    function downloadLogbook() {
        const blob = new Blob(
            [
                new ADIF({ qsos: logbook }).stringify({
                    fieldDelim: "\n",
                    recordDelim: "\n",
                }),
            ],
            { type: "text/plain;charset=utf-8;" },
        );
        saveAs(blob, `${remoteState?.currentUser.callsign ?? "logbook"}.adi`);
    }

    // Start capturing the microphone (opus-recorder global from
    // static/recorder.js) and create the audio context used for playback.
    function enableMic() {
        recorder = new Recorder({
            // 2049 = OPUS_APPLICATION_AUDIO
            encoderApplication: 2049,
            encoderFrameSize: 40,
            streamPages: true,
            // Emit bare Opus frames, not Ogg pages, so the server can forward them as-is
            rawOpus: true,
        });
        // Only stream microphone audio while push-to-talk is active in voice mode
        recorder.ondataavailable = (data) => {
            if (remoteState?.transmitting && remoteState.mode === "voice") {
                socket?.emit("audio", data);
            }
        };

        recorder.start();
        context = new AudioContext({ sampleRate: 48_000 });
    }

    // When output gain is changed
    $effect(() => {
        const gainNode = untrack(() => outputGainNode);
        const gain = outputGain;
        if (gainNode) {
            gainNode.gain.value = gain;
        }
    });

    // When mic gain is changed
    $effect(() => {
        const leRecorder = untrack(() => recorder);
        const gain = micGain;
        if (leRecorder) {
            leRecorder.setRecordingGain(gain);
        }
    });

    // Validate the uploaded key file, build the audio pipeline and connect to
    // the station server named in the key.
    async function connect(file: File) {
        console.log("connecting :3");
        status = "connecting";
        const rawKey = await file.text();
        try {
            if (!context || !recorder) {
                throw new Error("Audio is not enabled");
            }

            const audioContext = context;
            const activeRecorder = recorder;
            // Pull the JSON key object out of the file; the file may carry
            // extra data (e.g. a signature) around it.
            const json = JSON.parse(
                rawKey.match(
                    /\{"callsign":"[0-9A-Z]{1,15}","license":"[a-z]+","id":"\d+","url":"[\-.\/0-9:a-z]+","expiration":\d+\}/v,
                )![0],
            ) as { url: string };

            // Receive pipeline: Opus frames from the server -> decoder ->
            // queue node (plays PCM back-to-back) -> gain -> speakers
            const decoder = new OpusDecoder();
            await decoder.ready;
            let queueNode = new BufferQueueNode({ audioContext });
            const gainNode = new GainNode(audioContext);
            outputGainNode = gainNode;
            queueNode.connect(gainNode);
            gainNode.connect(audioContext.destination);
            // Temporary workaround to keep latency from getting too bad, need more empirical testing though.
            // Buffered audio piles up over time; swapping in a fresh queue drops it.
            setInterval(() => {
                queueNode.disconnect(gainNode);
                queueNode = new BufferQueueNode({ audioContext });
                queueNode.connect(gainNode);
            }, queueResetIntervalMs);

            const activeSocket: RemoteSocket = io(json.url);
            socket = activeSocket;
            // eslint-disable-next-line unicorn/no-global-object-property-assignment -- debugging hook
            globalThis.socket = activeSocket;
            // Authenticate with the raw key file as soon as we are connected
            // (also on every reconnect)
            activeSocket.on("connect", () => {
                activeSocket.emit("auth", rawKey);
            });
            activeSocket.on("disconnect", () => {
                status = "disconnected";
            });
            activeSocket.on("state", (state) => {
                remoteState = state;
            });
            // Signal strength, limited to the S-meter's range
            activeSocket.on("dbm", (level) => {
                dbm = clamp(level, -121, -33);
                dbmList.push(dbm);
                if (dbmList.length > dbmWindow) {
                    dbmList.shift();
                }
            });
            activeSocket.on("pwr", (watts) => {
                pwr = watts;
            });
            // Keep a rolling window of SWR readings; the meter shows their average
            activeSocket.on("swr", (reading) => {
                swrList.push(reading);
                if (swrList.length > swrWindow) {
                    swrList.shift();
                }
            });
            // Decode the Opus frame (mono, 48 kHz) and queue the PCM for playback
            activeSocket.on("audio", (chunk) => {
                queueNode._write(
                    decoder.decodeFrame(new Uint8Array(chunk)).channelData[0]!,
                    "",
                    () => {},
                );
            });
            // Login succeeded: the server sends station info, then we fetch the logbook
            activeSocket.on("login", (info: LoginInfo) => {
                bands = info.bands;
                clubName = info.clubName;
                clubEmail = info.clubEmail;
                activeSocket.emit("getLogbook");
                status = "connected";
            });
            activeSocket.on("logbook", (logs) => {
                logbook = logs;
            });
            activeSocket.on("error", (message) => {
                pushError(message);
            });

            // Mic level meter: tap the recorder's gain node with a script
            // processor that measures each block's average level and clipping.
            // I'm actually not sure we need to do this but meh
            const scriptNode =
                activeRecorder.audioContext.createScriptProcessor(4096, 1, 0);
            scriptNode.addEventListener("audioprocess", (event) => {
                const data = event.inputBuffer.getChannelData(0);
                clipping = false;
                for (const sample of data) {
                    if (Math.abs(sample) >= 1) {
                        clipping = true;
                        break;
                    }
                }

                micLevel = Math.min(avg(data.map((x) => Math.abs(x))), 1);
            });
            activeRecorder.recordingGainNode.connect(scriptNode);
        } catch (error) {
            console.log(error);
            pushError("Invalid key!");
            status = "disconnected";
        }
    }

    // When a key file is uploaded, connect with it
    $effect(() => {
        const file = files?.[0];
        if (file) {
            connect(file).catch((error: unknown) => {
                console.error(error);
            });
        }
    });

    // Submit a new logbook entry to the server
    function submitEntry() {
        if (
            logCallsign.length === 0 ||
            logRstRx.length === 0 ||
            logRstTx.length === 0 ||
            logTime.length === 0 ||
            !/^\d{1,2}:\d{2}$/v.test(logTime)
        ) {
            return;
        }

        const date = new Date();
        socket?.emit("newEntry", {
            // "HH:MM" -> "HHMMSS" (ADIF time, seconds zeroed)
            TIME_ON: logTime.replace(":", "").padStart(4, "0").padEnd(6, "0"),
            CALL: logCallsign.toUpperCase(),
            MODE: "SSB",
            // ADIF date (YYYYMMDD); getUTCMonth() is zero-based, hence the + 1
            QSO_DATE: `${date.getUTCFullYear()}${(date.getUTCMonth() + 1).toString().padStart(2, "0")}${date.getUTCDate().toString().padStart(2, "0")}`,
            RST_RCVD: logRstRx,
            RST_SENT: logRstTx,
            // Frequency is in 10 Hz units; the logbook stores MHz
            FREQ: ((remoteState?.frequency ?? 0) / 100_000).toString(),
        });
        logTime = "";
        logCallsign = "";
        logRstRx = "";
        logRstTx = "";
    }
</script>

{#if status === "disconnected"}
    <div
        class="w-screen min-h-screen flex flex-col items-center justify-center gap-2"
    >
        <h1 class="text-3xl font-semibold">freeremote</h1>
        {#if context}
            <p class="text-center">
                Please upload your key below to access your remote station.
            </p>
            <input
                accept="text/plain"
                bind:files
                type="file"
                class="file-input"
            />
        {:else}
            <p>Please click the button below to continue.</p>
            <button class="btn btn-soft" onclick={enableMic}>
                Enable microphone
            </button>
        {/if}
    </div>
{:else if status === "connecting"}
    <div
        class="w-screen min-h-screen flex flex-col items-center justify-center gap-2"
    >
        <span class="loading loading-spinner loading-xl"></span>
    </div>
{:else}
    <div class="w-screen min-h-screen flex flex-col">
        <div
            class="w-screen bg-base-200 shadow-sm flex items-center px-2 py-2 gap-2"
        >
            <div class="dropdown">
                <div tabindex="0" role="button" class="btn btn-soft">
                    {currentBand}
                </div>
                <ul
                    tabindex="0"
                    class="dropdown-content menu bg-base-200 rounded-box z-1 w-52 p-2 shadow-sm"
                >
                    {#each Object.keys(bands) as band (band)}
                        <li>
                            <a onclick={() => selectBand(band)}>{band}</a>
                        </li>
                    {/each}
                </ul>
            </div>
            <div class="dropdown">
                <div tabindex="0" role="button" class="btn btn-soft">
                    {remoteState ? modes[remoteState.mode] : undefined}
                </div>
                <ul
                    tabindex="0"
                    class="dropdown-content menu bg-base-200 rounded-box z-1 w-52 p-2 shadow-sm"
                >
                    <li><a>Voice</a></li>
                    <li><a>FT8</a></li>
                    <li><a>PSK31</a></li>
                </ul>
            </div>
            <button
                class="btn btn-soft btn-success"
                onclick={() => socket?.emit("tune")}>Tune</button
            >
            <div class="flex-grow"></div>
            <p>
                <a class="link" href="mailto:{clubEmail}">{clubName}</a> - {remoteState
                    ?.currentUser.callsign}
            </p>
        </div>
        {#if remoteState?.mode === "voice"}
            <div class="flex flex-col flex-grow items-center p-4">
                <div
                    class="flex lg:flex-row md:flex-row flex-col w-full flex-grow gap-4"
                >
                    <div
                        class="flex flex-col items-center justify-center gap-4"
                    >
                        <div
                            class="card card-border bg-base-200 lg:w-[30vw] md:w-[50vw] w-[85vw]"
                        >
                            <div class="card-body font-mono">
                                <div class="lg:hidden md:hidden flex flex-row">
                                    <button
                                        class="btn btn-soft"
                                        onclick={() => changeFrequency(-100)}
                                    >
                                        -1 kHz
                                    </button>
                                    <div class="flex-grow"></div>
                                    <button
                                        class="btn btn-soft"
                                        onclick={() => changeFrequency(100)}
                                    >
                                        +1 kHz
                                    </button>
                                </div>
                                <div
                                    class="flex flex-row items-center justify-center"
                                >
                                    {#each [7, 6, 5, 4, 3, 2, 1] as i (i)}
                                        <h1
                                            class="text-6xl"
                                            onwheel={(event) => {
                                                event.preventDefault();
                                                // Scroll up raises the digit's place value, down lowers it
                                                changeFrequency(
                                                    (event.deltaY < 0
                                                        ? 1
                                                        : -1) *
                                                        10 ** (i - 1),
                                                );
                                            }}
                                        >
                                            {frequencyDigit(i)}
                                        </h1>
                                        {#if i === 3}
                                            <h1 class="text-6xl">.</h1>
                                        {/if}
                                    {/each}
                                </div>
                            </div>
                        </div>
                        <div
                            class="rounded-box border border-base-content/5 bg-base-200 lg:w-[30vw] md:w-[50vw] w-[85vw]"
                        >
                            <table class="table">
                                <tbody>
                                    <tr>
                                        <td>
                                            <progress
                                                class="progress progress-primary"
                                                value={dbm + 121}
                                                max="88"
                                            ></progress>
                                        </td>
                                        <td>
                                            <div
                                                class="tooltip"
                                                data-tip={`${dbm} dBm`}
                                            >
                                                <p>{sunits}</p>
                                            </div>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td>
                                            <progress
                                                class="progress progress-warning"
                                                value={pwr}
                                                max={remoteState?.maxpwr}
                                            ></progress>
                                        </td>
                                        <td>
                                            <div
                                                class="tooltip"
                                                data-tip="May not work on some transceivers."
                                            >
                                                <p>{pwr}W</p>
                                            </div>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td>
                                            <progress
                                                class="progress progress-error"
                                                value={swr}
                                                max="100"
                                            ></progress>
                                        </td>
                                        <td>
                                            <div
                                                class="tooltip"
                                                data-tip="SWR is approximate. Accuracy not guaranteed."
                                            >
                                                <p>
                                                    {swrText}:1
                                                </p>
                                            </div>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td>
                                            <progress
                                                class="progress {clipping
                                                    ? 'progress-error'
                                                    : 'progress-success'}"
                                                value={micLevel}
                                                max="1"
                                            ></progress>
                                        </td>
                                        <td>
                                            <div
                                                class="tooltip"
                                                data-tip="Set the mic gain so that this meter is as high as possible when you speak. If the meter is red while you speak, your voice may be clipping."
                                            >
                                                <p>Mic</p>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div
                            class="card card-border bg-base-200 lg:w-[30vw] md:w-[50vw] w-[85vw]"
                        >
                            <div class="card-body w-full">
                                <p class="text-center">Output gain</p>
                                <div class="w-full">
                                    <input
                                        type="range"
                                        min="0"
                                        max="3"
                                        bind:value={outputGain}
                                        class="w-full range"
                                        step="0.1"
                                    />
                                    <div
                                        class="flex justify-between px-2.5 mt-2 text-xs"
                                    >
                                        <span>|</span>
                                        <span>|</span>
                                        <span>|</span>
                                        <span>|</span>
                                    </div>
                                    <div
                                        class="flex justify-between px-2.5 mt-2 text-xs"
                                    >
                                        <span>Muted</span>
                                        <span>100%</span>
                                        <span>200%</span>
                                        <span>300%</span>
                                    </div>
                                </div>
                                <p class="text-center">Mic gain</p>
                                <div class="w-full">
                                    <input
                                        type="range"
                                        min="0"
                                        max="3"
                                        bind:value={micGain}
                                        class="w-full range"
                                        step="0.1"
                                    />
                                    <div
                                        class="flex justify-between px-2.5 mt-2 text-xs"
                                    >
                                        <span>|</span>
                                        <span>|</span>
                                        <span>|</span>
                                        <span>|</span>
                                    </div>
                                    <div
                                        class="flex justify-between px-2.5 mt-2 text-xs"
                                    >
                                        <span>Muted</span>
                                        <span>100%</span>
                                        <span>200%</span>
                                        <span>300%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="flex flex-col flex-grow gap-4">
                        <div class="flex flex-row gap-2">
                            <h1 class="text-3xl font-semibold">Logbook</h1>
                            <button
                                class="btn btn-square btn-soft material-symbols-outlined"
                                onclick={downloadLogbook}
                            >
                                download
                            </button>
                        </div>
                        <div class="flex flex-col gap-2">
                            <div class="flex lg:flex-row flex-col gap-2">
                                <input
                                    type="text"
                                    placeholder="Callsign"
                                    class="input"
                                    bind:value={logCallsign}
                                />
                                <div class="join">
                                    <input
                                        type="text"
                                        placeholder="Time (UTC)"
                                        class="input join-item"
                                        bind:value={logTime}
                                    />
                                    <button
                                        class="btn btn-soft join-item"
                                        onclick={() => {
                                            const date = new Date();
                                            logTime = `${date.getUTCHours().toString().padStart(2, "0")}:${date.getUTCMinutes().toString().padStart(2, "0")}`;
                                        }}
                                    >
                                        Now
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    placeholder="RST (sent)"
                                    class="input"
                                    bind:value={logRstTx}
                                />
                                <input
                                    type="text"
                                    placeholder="RST (rcvd)"
                                    class="input"
                                    bind:value={logRstRx}
                                />
                            </div>
                            <div>
                                <button
                                    class="btn btn-primary"
                                    onclick={submitEntry}
                                >
                                    Add entry
                                </button>
                            </div>
                        </div>
                        {#if logbook.length === 0}
                            <div
                                class="flex flex-col flex-grow w-full items-center justify-center rounded-box border border-base-content/5 bg-base-200 max-h-[60vh]"
                            >
                                <p>No entries found.</p>
                            </div>
                        {:else}
                            <div
                                class="overflow-y-scroll overflow-x-auto rounded-box border border-base-content/5 bg-base-200 w-full max-h-[60vh] flex-grow"
                            >
                                <table class="table">
                                    <thead>
                                        <tr>
                                            <th>Callsign</th>
                                            <th>Mode</th>
                                            <th>Freq (MHz)</th>
                                            <th>RST (sent)</th>
                                            <th>RST (rcvd)</th>
                                            <th>Date (UTC)</th>
                                            <th>Time (UTC)</th>
                                            <th>Delete</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {#each logbook as entry, i (i)}
                                            <tr>
                                                <td>{entry.CALL}</td>
                                                <td>{entry.MODE}</td>
                                                <td>{entry.FREQ}</td>
                                                <td>{entry.RST_SENT}</td>
                                                <td>{entry.RST_RCVD}</td>
                                                <td>{entry.QSO_DATE}</td>
                                                <td>{entry.TIME_ON}</td>
                                                <td>
                                                    <button
                                                        class="btn btn-soft btn-square btn-error material-symbols-outlined"
                                                        onclick={() => {
                                                            logbook.splice(
                                                                i,
                                                                1,
                                                            );
                                                            socket?.emit(
                                                                "updateLogbook",
                                                                $state.snapshot(
                                                                    logbook,
                                                                ),
                                                            );
                                                        }}
                                                    >
                                                        delete
                                                    </button>
                                                </td>
                                            </tr>
                                        {/each}
                                    </tbody>
                                </table>
                            </div>
                        {/if}
                    </div>
                </div>
            </div>
            <div class="toast toast-bottom toast-end">
                <button
                    class="btn btn-xl {remoteState?.transmitting
                        ? 'btn-error'
                        : 'btn-primary'} btn-circle"
                    onclick={() => {
                        // Toggle push-to-talk
                        if (remoteState?.transmitting) {
                            socket?.emit("unptt");
                        } else {
                            socket?.emit("ptt");
                        }
                    }}
                >
                    <div class="material-symbols-outlined">mic</div>
                </button>
            </div>
        {/if}
    </div>
{/if}

<div class="toast toast-top toast-end">
    {#each errors as error, i (error.id)}
        <div role="alert" class="alert alert-error" transition:fade>
            <span>{error.message}</span>
            <button
                class="material-symbols-outlined cursor-pointer"
                onclick={() => {
                    errors.splice(i, 1);
                }}
            >
                close
            </button>
        </div>
    {/each}
</div>
