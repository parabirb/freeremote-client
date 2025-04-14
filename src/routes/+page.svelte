<script>
    // deps
    import saveAs from "file-saver";
    import { untrack } from "svelte";
    import io from "socket.io-client";
    import ADIF from "tcadif/lib/ADIF";
    import { fade } from "svelte/transition";
    import BufferQueueNode from "$lib/queue";
    import { OpusDecoder } from "opus-decoder";
    import { Waterfall } from "$lib/spectrogram";

    function clamp(val, min, max) {
        return Math.min(Math.max(val, min), max);
    }

    function avg(arr) {
        return arr.reduce((prev, cur) => prev + cur, 0) / arr.length;
    }

    const modes = {
        voice: "Voice",
        ft8: "FT8",
        psk31: "PSK31",
    };

    // state vars
    let status = $state("disconnected");
    let remoteState = $state();
    let files = $state();
    let errors = $state([]);
    let dbm = $state(0);
    let dbmList = $state([0]);
    let pwr = $state(0);
    let swrList = $state([0]);
    let swr = $derived(avg(swrList));
    let context = $state();
    let micGain = $state(1);
    let outputGain = $state(1);
    let micLevel = $state(0);
    let clipping = $state(false);
    let recorder;
    let sunits = $derived.by(() => {
        let average = avg(dbmList);
        if (average > 79) {
            return `S9+${average - 73}`;
        } else {
            return `S${Math.round(clamp((average + 127) / 6, 1, 9))}`;
        }
    });
    let socket;
    let canvas;
    let bands = $state([]);
    let currentBand = $derived.by(() => {
        try {
            let bandKeys = Object.keys(bands);
            let bandValues = Object.values(bands);
            return bandKeys[
                bandValues.indexOf(
                    bandValues.find(
                        (band) =>
                            band.edges[0] <= remoteState.frequency &&
                            band.edges[1] > remoteState.frequency
                    )
                )
            ];
        } catch {
            return "";
        }
    });
    let clubName = $state("");
    let clubEmail = $state("");
    let logbook = $state([]);
    let outputGainNode;
    let logCallsign = $state("");
    let logTime = $state("");
    let logRstTx = $state("");
    let logRstRx = $state("");

    async function enableMic() {
        recorder = new Recorder({
            encoderApplication: 2049,
            encoderFrameSize: 40,
            streamPages: true,
            rawOpus: true,
        });
        recorder.ondataavailable = (data) => {
            if (remoteState?.transmitting && remoteState.mode === "voice")
                socket.emit("audio", data);
        };
        recorder.start();
        context = new AudioContext({ sampleRate: 48000 });
    }

    // when output gain is changed
    $effect(() => {
        let gainNode = untrack(() => outputGainNode);
        let gain = outputGain;
        if (gainNode) gainNode.gain.value = gain;
    });

    // when mic gain is changed
    $effect(() => {
        let leRecorder = untrack(() => recorder);
        let gain = micGain;
        if (leRecorder) leRecorder.setRecordingGain(gain);
    });

    // when the file is uploaded we do the thing
    $effect(async () => {
        if (files && files.length > 0) {
            console.log("connecting :3");
            status = "connecting";
            let rawKey = await files[0].text();
            try {
                let json = JSON.parse(
                    rawKey.match(
                        /{"callsign":"[A-Z0-9]{1,15}","license":"[a-z]+","id":"[0-9]+","url":"[a-z0-9\-\:/.]+","expiration":[0-9]+}/
                    )[0]
                );
                const decoder = new OpusDecoder();
                await decoder.ready;
                let queueNode = new BufferQueueNode({
                    audioContext: context,
                });
                outputGainNode = new GainNode(context);
                queueNode.connect(outputGainNode);
                outputGainNode.connect(context.destination);
                // temporary workaround to keep latency from getting too bad, need more empirical testing though
                setInterval(() => {
                    queueNode.disconnect(outputGainNode);
                    queueNode = new BufferQueueNode({
                        audioContext: context,
                    });
                    queueNode.connect(outputGainNode);
                }, 120 * 1000);
                socket = io(json.url);
                window.socket = socket;
                socket.on("connect", () => {
                    socket.emit("auth", rawKey);
                });
                socket.on("disconnect", () => {
                    status = "disconnected";
                });
                socket.on("state", (state) => {
                    remoteState = state;
                });
                socket.on("dbm", (d) => {
                    dbm = clamp(d, -121, -33);
                    dbmList.push(dbm);
                    if (dbmList.length > 25) dbmList.shift();
                });
                socket.on("pwr", (p) => {
                    pwr = p;
                });
                socket.on("swr", (s) => {
                    swrList.push(swr);
                    if (swrList.length > 10) swrList.shift();
                });
                socket.on("audio", (chunk) => {
                    queueNode._write(
                        decoder.decodeFrame(new Uint8Array(chunk))
                            .channelData[0],
                        null,
                        () => {}
                    );
                });
                socket.on("login", (info) => {
                    bands = info.bands;
                    clubName = info.clubName;
                    clubEmail = info.clubEmail;
                    socket.emit("getLogbook");
                    status = "connected";
                });
                socket.on("logbook", (logs) => {
                    logbook = logs;
                });
                socket.on("error", (err) => errors.unshift(err));
                // i'm actually not sure we need to do this but meh
                let untrackedRecorder = untrack(() => recorder);
                let scriptNode =
                    untrackedRecorder.audioContext.createScriptProcessor(
                        4096,
                        1,
                        0
                    );
                scriptNode.addEventListener("audioprocess", (e) => {
                    let data = e.inputBuffer.getChannelData(0);
                    clipping = false;
                    for (let i = 0; i < data.length; i++) {
                        if (Math.abs(data[i]) >= 1) {
                            clipping = true;
                            break;
                        }
                    }
                    micLevel = Math.min(avg(data.map((x) => Math.abs(x))), 1);
                });
                untrackedRecorder.recordingGainNode.connect(scriptNode);
            } catch (e) {
                console.log(e);
                errors.unshift("Invalid key!");
                status = "disconnected";
                return;
            }
        }
    });

    // submit entry function
    function submitEntry() {
        if (
            logCallsign.length === 0 ||
            logRstRx.length === 0 ||
            logRstTx.length === 0 ||
            logTime.length === 0 ||
            !/^[0-9]{1,2}:[0-9]{2}$/.test(logTime)
        )
            return;
        let date = new Date();
        socket.emit("newEntry", {
            TIME_ON: logTime.replace(":", "").padStart(4, "0").padEnd(6, "0"),
            CALL: logCallsign.toUpperCase(),
            MODE: "SSB",
            QSO_DATE: `${date.getUTCFullYear()}${date.getUTCMonth().toString().padStart(2, "0")}${date.getUTCDate().toString().padStart(2, "0")}`,
            RST_RCVD: logRstRx,
            RST_SENT: logRstTx,
            FREQ: (remoteState.frequency / 100000).toString(),
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
                    {#each Object.keys(bands) as band}
                        <li>
                            <a
                                onclick={() => {
                                    if (remoteState.mode === "voice") {
                                        socket.emit(
                                            "frequency",
                                            bands[band].voice[0]
                                        );
                                    } else if (remoteState.mode === "psk31") {
                                        socket.emit(
                                            "frequency",
                                            bands[band].psk31
                                        );
                                    } else {
                                        socket.emit(
                                            "frequency",
                                            bands[band].ft8
                                        );
                                    }
                                    document.activeElement.blur();
                                }}>{band}</a
                            >
                        </li>
                    {/each}
                </ul>
            </div>
            <div class="dropdown">
                <div tabindex="0" role="button" class="btn btn-soft">
                    {modes[remoteState?.mode]}
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
                onclick={() => socket.emit("tune")}>Tune</button
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
                                        onclick={() =>
                                            socket.emit(
                                                "frequency",
                                                remoteState.frequency - 100
                                            )}
                                    >
                                        -1 kHz
                                    </button>
                                    <div class="flex-grow"></div>
                                    <button
                                        class="btn btn-soft"
                                        onclick={() =>
                                            socket.emit(
                                                "frequency",
                                                remoteState.frequency + 100
                                            )}
                                    >
                                        +1 kHz
                                    </button>
                                </div>
                                <div
                                    class="flex flex-row items-center justify-center"
                                >
                                    {#each [7, 6, 5, 4, 3, 2, 1] as i}
                                        <h1
                                            class="text-6xl"
                                            onwheel={(e) => {
                                                e.preventDefault();
                                                if (e.deltaY < 0) {
                                                    socket.emit(
                                                        "frequency",
                                                        remoteState.frequency +
                                                            10 ** (i - 1)
                                                    );
                                                } else {
                                                    socket.emit(
                                                        "frequency",
                                                        remoteState.frequency -
                                                            10 ** (i - 1)
                                                    );
                                                }
                                            }}
                                        >
                                            {(() => {
                                                let digit = Math.floor(
                                                    (remoteState?.frequency %
                                                        10 ** i) /
                                                        10 ** (i - 1)
                                                );
                                                if (isNaN(digit)) return 0;
                                                else return digit;
                                            })()}
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
                                                    {(() => {
                                                        if (swr > 50)
                                                            return "∞";
                                                        else
                                                            return (
                                                                1 +
                                                                Math.floor(
                                                                    (swr / 11) *
                                                                        0.5 *
                                                                        10
                                                                ) /
                                                                    10
                                                            );
                                                    })()}:1
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
                                onclick={() => {
                                    let blob = new Blob(
                                        [
                                            new ADIF({
                                                qsos: logbook,
                                            }).stringify({
                                                fieldDelim: "\n",
                                                recordDelim: "\n",
                                            }),
                                        ],
                                        { type: "text/plain;charset=utf-8;" }
                                    );
                                    saveAs(
                                        blob,
                                        `${remoteState.currentUser.callsign}.adi`
                                    );
                                }}
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
                                            let date = new Date();
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
                                        {#each logbook as entry, i}
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
                                                                1
                                                            );
                                                            socket.emit(
                                                                "updateLogbook",
                                                                logbook
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
                        if (!remoteState.transmitting) socket.emit("ptt");
                        else socket.emit("unptt");
                    }}
                >
                    <div class="material-symbols-outlined">mic</div>
                </button>
            </div>
        {/if}
    </div>
    <!--<canvas bind:this={canvas} class="w-full h-[25vh]"></canvas>-->
{/if}

<div class="toast toast-top toast-end">
    {#each errors as error, i}
        <div role="alert" class="alert alert-error" transition:fade>
            <span>{error}</span>
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
