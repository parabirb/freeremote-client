// Socket.io protocol spoken with freeremote-server.
// Event names and payload shapes are dictated by the server; do not change
// them here without changing the server too.

import type { Socket } from "socket.io-client";
import type { Qso } from "tcadif/lib/ADIF";

export type Mode = "voice" | "ft8" | "psk31";

/**
Amateur band as announced by the server. Frequencies are in 10 Hz units.
*/
export type Band = {
    /**
    [lower, upper) band edge.
    */
    edges: [number, number];
    /**
    Voice frequencies; the first one is used as the default.
    */
    voice: number[];
    psk31: number;
    ft8: number;
};

export type Bands = Record<string, Band>;

/**
Radio state broadcast by the server. `frequency` is in 10 Hz units.
*/
export type RemoteState = {
    frequency: number;
    mode: Mode;
    transmitting: boolean;
    /**
    Maximum transmit power in watts (scale of the power meter).
    */
    maxpwr: number;
    currentUser: { callsign: string };
};

/**
Station details sent once after a successful `auth`.
*/
export type LoginInfo = {
    bands: Bands;
    clubName: string;
    clubEmail: string;
};

/**
Events the server emits.
*/
export type ServerToClientEvents = {
    login: (info: LoginInfo) => void;
    state: (state: RemoteState) => void;
    error: (message: string) => void;
    /**
    One Opus frame of received audio.
    */
    audio: (chunk: ArrayBuffer) => void;
    swr: (value: number) => void;
    pwr: (watts: number) => void;
    dbm: (level: number) => void;
    logbook: (entries: Qso[]) => void;
};

/**
Events the client emits.
*/
export type ClientToServerEvents = {
    /**
    Raw contents of the user's key file.
    */
    auth: (key: string) => void;
    ptt: () => void;
    unptt: () => void;
    /**
    One Opus frame of microphone audio.
    */
    audio: (frame: Uint8Array) => void;
    frequency: (frequency: number) => void;
    tune: () => void;
    getLogbook: () => void;
    newEntry: (entry: Qso) => void;
    updateLogbook: (entries: Qso[]) => void;
};

export type RemoteSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

declare global {
    // The socket is exposed on `globalThis` for debugging from the console.

    var socket: RemoteSocket | undefined;
}
