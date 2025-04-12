<script>
    // deps
    import BufferQueueNode from "$lib/queue";
    import { untrack } from "svelte";
    import io from "socket.io-client";
    import { fade } from "svelte/transition";
    import { OpusDecoder } from "opus-decoder";

    function clamp(val, min, max) {
        return Math.min(Math.max(val, min), max);
    }

    function avg(arr) {
        return arr.reduce((prev, cur) => prev + cur, 0) / arr.length;
    }

    // state vars
    let status = $state("disconnected");
    let remoteState = $state();
    let files = $state();
    let errors = $state([]);
    let dbm = $state(0);
    let dbmList = $state([0]);
    let pwr = $state(0);
    let swr = $state(0);
    let context = $state();
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

    async function enableMic() {
        recorder = new Recorder({
            encoderApplication: 2049,
            encoderFrameSize: 40,
            streamPages: true,
            rawOpus: true,
        });
        recorder.ondataavailable = (data) => {
            if (remoteState?.transmitting) socket.emit("audio", data);
        };
        recorder.start();
        context = new AudioContext({ sampleRate: 48000 });
    }

    // when the file is uploaded we do the thing
    $effect(async () => {
        if (files && files.length > 0) {
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
                queueNode.connect(context.destination);
                socket = io(json.url);
                window.socket = socket;
                socket.on("connect", () => {
                    status = "connected";
                    socket.emit("auth", rawKey);
                });
                socket.on("disconnect", () => {
                    status = "disconnected";
                });
                socket.on("state", (state) => {
                    remoteState = state;
                });
                socket.on("dbm", (d) => {
                    dbm = Math.min(d, -33);
                    dbmList.push(dbm);
                    if (dbmList.length > 25) dbmList.shift();
                });
                socket.on("pwr", (p) => {
                    pwr = p;
                });
                socket.on("swr", (s) => {
                    swr = s;
                });
                socket.on("audio", (chunk) => {
                    queueNode._write(
                        decoder.decodeFrame(new Uint8Array(chunk))
                            .channelData[0],
                        null,
                        () => {}
                    );
                });
            } catch (e) {
                console.log(e);
                errors.unshift("Invalid key!");
                status = "disconnected";
                return;
            }
        }
    });
</script>

{#if status === "disconnected"}
    <div
        class="w-screen min-h-screen flex flex-col items-center justify-center gap-2"
    >
        <h1 class="text-3xl font-semibold">freeremote</h1>
        {#if context}
            <p>Please upload your key below to access your remote station.</p>
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
    <p>{remoteState?.frequency}</p>
    <p>{dbm}</p>
    <p>{sunits}</p>
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
