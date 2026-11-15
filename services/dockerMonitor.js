
const Docker = require("dockerode");

const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock"
});

// Track active log streams per Socket.IO client
const activeStreams = new Map();

function initializeDockerMonitor(io) {
    console.log("Initializing Docker Monitor...");

    // Listen for Docker events
    startDockerEvents(io);

    io.on("connection", (socket) => {
        console.log("Docker monitor client connected:", socket.id);

        activeStreams.set(socket.id, new Map());

        // Start logs for one or multiple containers
        socket.on("container:logs:start", async (payload = {}) => {
            const containerIds = Array.isArray(payload.containerIds)
                ? payload.containerIds
                : payload.containerId
                    ? [payload.containerId]
                    : [];

            const tail = Math.min(
                Math.max(Number(payload.tail) || 200, 1),
                2000
            );

            if (!containerIds.length) {
                socket.emit("container:logs:error", {
                    message: "Please provide at least one container ID"
                });
                return;
            }

            // Remove duplicates
            const uniqueIds = [...new Set(containerIds)];

            for (const containerId of uniqueIds) {
                try {
                    await startContainerLogs(
                        socket,
                        containerId,
                        tail
                    );
                } catch (error) {
                    socket.emit("container:logs:error", {
                        containerId,
                        message: error.message
                    });
                }
            }
        });

        // Stop a specific container log stream
        socket.on("container:logs:stop", (payload = {}) => {
            const { containerId } = payload;
            stopContainerLogs(socket, containerId);
        });

        // Stop all selected container log streams
        socket.on("container:logs:stop-all", () => {
            stopAllContainerLogs(socket);
        });

        socket.on("disconnect", () => {
            stopAllContainerLogs(socket);
            activeStreams.delete(socket.id);

            console.log("Docker monitor client disconnected:", socket.id);
        });
    });
}


// Start logs for one container
async function startContainerLogs(socket, containerId, tail) {
    const streams = activeStreams.get(socket.id);

    if (!streams) {
        throw new Error("Socket session not found");
    }

    // Avoid duplicate streams for the same container
    if (streams.has(containerId)) {
        stopContainerLogs(socket, containerId);
    }

    const container = docker.getContainer(containerId);

    const details = await container.inspect();

    if (!details.State.Running) {
        throw new Error("Container is not currently running");
    }

    const containerName = details.Name.replace(/^\//, "");

    const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        timestamps: true,
        tail
    });

    const streamInfo = {
        containerId,
        containerName,
        logStream
    };

    streams.set(containerId, streamInfo);

    // Dockerode exposes a demultiplexer for Docker's
    // multiplexed stdout/stderr log stream.
    const stdout = {
        write: (chunk) => {
            emitLog(socket, containerId, containerName, "stdout", chunk);
        }
    };

    const stderr = {
        write: (chunk) => {
            emitLog(socket, containerId, containerName, "stderr", chunk);
        }
    };

    container.modem.demuxStream(logStream, stdout, stderr);

    logStream.on("end", () => {
        const current = streams.get(containerId);

        if (current?.logStream === logStream) {
            streams.delete(containerId);
        }

        socket.emit("container:logs:ended", {
            containerId,
            containerName
        });
    });

    logStream.on("error", (error) => {
        streams.delete(containerId);

        socket.emit("container:logs:error", {
            containerId,
            containerName,
            message: error.message
        });
    });

    socket.emit("container:logs:started", {
        containerId,
        containerName,
        message: "Live logs started"
    });

    console.log(`Live logs started: ${containerName}`);
}


// Send log data to frontend
function emitLog(socket, containerId, containerName, stream, chunk) {
    const text = chunk.toString("utf8");

    if (!text) return;

    socket.emit("container:logs:data", {
        containerId,
        containerName,
        stream,
        chunk: text,
        timestamp: new Date().toISOString()
    });
}


// Stop one container's logs
function stopContainerLogs(socket, containerId) {
    const streams = activeStreams.get(socket.id);

    if (!streams) return;

    const streamInfo = streams.get(containerId);

    if (!streamInfo) return;

    streamInfo.logStream.destroy();
    streams.delete(containerId);

    socket.emit("container:logs:stopped", {
        containerId,
        containerName: streamInfo.containerName
    });

    console.log(`Live logs stopped: ${streamInfo.containerName}`);
}


// Stop all logs for a client
function stopAllContainerLogs(socket) {
    const streams = activeStreams.get(socket.id);

    if (!streams) return;

    for (const [containerId, streamInfo] of streams.entries()) {
        streamInfo.logStream.destroy();

        socket.emit("container:logs:stopped", {
            containerId,
            containerName: streamInfo.containerName
        });
    }

    streams.clear();
}


// Docker events: container stop / die / OOM
function startDockerEvents(io) {
    async function connectEvents() {
        try {
            const eventStream = await docker.getEvents({
                filters: {
                    type: ["container"],
                    event: ["die", "oom", "stop"]
                }
            });

            console.log("Docker event monitoring started");

            eventStream.on("data", async (data) => {
                try {
                    const event = JSON.parse(data.toString());

                    const containerId = event.Actor?.ID;

                    if (!containerId) return;

                    const container = docker.getContainer(containerId);

                    let details = null;

                    try {
                        details = await container.inspect();
                    } catch (error) {
                        // Container may have been removed after the event
                    }

                    const attributes = event.Actor?.Attributes || {};

                    const containerName =
                        details?.Name?.replace(/^\//, "") ||
                        attributes.name ||
                        containerId.substring(0, 12);

                    const project =
                        attributes["com.docker.compose.project"] ||
                        details?.Config?.Labels?.[
                            "com.docker.compose.project"
                        ] ||
                        "ungrouped";

                    const eventData = {
                        containerId,
                        containerName,
                        project,
                        action: event.Action,
                        status: event.status || event.Action,
                        exitCode: details?.State?.ExitCode ?? null,
                        oomKilled: details?.State?.OOMKilled ?? false,
                        timestamp: event.timeNano
                            ? new Date(event.timeNano / 1000000).toISOString()
                            : new Date().toISOString()
                    };

                    io.emit("container:alert", eventData);

                    console.log("Docker event:", eventData);

                } catch (error) {
                    console.error("Docker event processing error:", error.message);
                }
            });

            eventStream.on("error", (error) => {
                console.error("Docker event stream error:", error.message);
                setTimeout(connectEvents, 5000);
            });

            eventStream.on("end", () => {
                console.log("Docker event stream ended. Reconnecting...");
                setTimeout(connectEvents, 5000);
            });

        } catch (error) {
            console.error("Docker event connection error:", error.message);
            setTimeout(connectEvents, 5000);
        }
    }

    connectEvents();
}

module.exports = {
    initializeDockerMonitor
};
