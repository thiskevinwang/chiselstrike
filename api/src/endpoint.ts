// SPDX-FileCopyrightText: © 2021 ChiselStrike <info@chiselstrike.com>

/// <reference lib="deno.core" />
/// <reference lib="dom" />
/// <reference lib="deno.unstable" />

const endpointWorker = new Worker("file:///worker.js", {
    type: "module",
    name: "endpointWorker",
    deno: {
        namespace: true,
    },
});
type Resolver = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    msg: unknown;
};
const resolvers: Resolver[] = [];
endpointWorker.onmessageerror = function (e) {
    throw e;
};
endpointWorker.onerror = function (e) {
    throw e;
};

const bodyParts: Record<number, Uint8Array[]> = {};
let bodyDone = false;
let resolveBody: (() => void) | undefined = undefined;
endpointWorker.onmessage = function (event) {
    const { msg, id, value, err } = event.data;
    if (msg == "body") {
        if (value !== undefined) {
            if (id in bodyParts) {
                bodyParts[id].push(value);
            }
        } else {
            bodyDone = true;
            if (resolveBody !== undefined) {
                resolveBody();
                resolveBody = undefined;
            }
        }
    } else {
        const resolver = resolvers[0];
        if (err) {
            resolver.reject(err);
        } else {
            resolver.resolve(value);
        }
    }
};

function sendMsg(msg: unknown) {
    const p = new Promise((resolve, reject) => {
        resolvers.push({ resolve, reject, msg });
    });
    // Each worker should handle a single request at a time, so we
    // only post a message if the worker is not currently
    // busy. Otherwise we leave it scheduled and know it will be
    // posted once the preceding messages are answered.
    if (resolvers.length == 1) {
        endpointWorker.postMessage(resolvers[0].msg);
    }
    return p;
}

async function toWorker(msg: unknown) {
    try {
        return await sendMsg(msg);
    } finally {
        endMsgProcessing();
    }
}

function endMsgProcessing() {
    resolvers.shift();
    // If a message was scheduled while the worker was busy, post
    // it now.
    if (resolvers.length != 0) {
        endpointWorker.postMessage(resolvers[0].msg);
    }
}

export async function initWorker(id: number) {
    await toWorker({ cmd: "initWorker", id });
}

export async function readWorkerChannel() {
    await toWorker({ cmd: "readWorkerChannel" });
}

export async function importEndpoint(
    path: string,
    apiVersion: string,
    version: number,
) {
    await toWorker({
        cmd: "importEndpoint",
        path,
        apiVersion,
        version,
    });
}

export async function activateEndpoint(path: string) {
    await toWorker({
        cmd: "activateEndpoint",
        path,
    });
}

export function endOfRequest(id: number) {
    endpointWorker.postMessage({ cmd: "endOfRequest", id });
    delete bodyParts[id];
}

export async function callHandler(
    path: string,
    apiVersion: string,
    id: number,
) {
    bodyParts[id] = [];

    let res;
    try {
        res = await sendMsg({
            cmd: "callHandler",
            path,
            apiVersion,
            id,
        }) as { status: number; headers: number };

        if (!bodyDone) {
            const p = new Promise<void>((resolve) => {
                resolveBody = resolve;
            });
            await p;
        }
    } finally {
        endMsgProcessing();
    }
    // Clear for the next request
    bodyDone = false;

    // The read function is called repeatedly until it returns
    // undefined.
    const read = function () {
        return bodyParts[id].shift();
    };
    return {
        "status": res.status,
        "headers": res.headers,
        "read": read,
    };
}
