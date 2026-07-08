/**
 * Lavalink Manager — Shoukaku integration for audio playback.
 *
 * Debug prototype-patches were previously unconditional and dumped
 * VOICE_STATE_UPDATE / session-id payloads to stdout on every event.
 * They are now gated behind DEBUG_LAVALINK=1 so production logs are quiet
 * and session IDs never touch stdout by default.
 */

const { Shoukaku, Connectors, Connection, Rest, Player } = require("shoukaku");

const DEBUG = process.env.DEBUG_LAVALINK === "1" || process.env.DEBUG_LAVALINK === "true";
const dlog = DEBUG ? (...a) => console.log(...a) : () => {};

// ─── Debug prototype patches — silenced by default ───
const originalJoinVoiceChannel = Shoukaku.prototype.joinVoiceChannel;
Shoukaku.prototype.joinVoiceChannel = function(options) {
    dlog(`[LAVALINK SHOUKAKU DEBUG] joinVoiceChannel called | Guild: ${options.guildId} | Channel: ${options.channelId}`);
    return originalJoinVoiceChannel.call(this, options)
        .then(player => {
            dlog(`[LAVALINK SHOUKAKU DEBUG] joinVoiceChannel succeeded! Player created for guild: ${player.guildId}`);
            return player;
        })
        .catch(err => {
            dlog(`[LAVALINK SHOUKAKU DEBUG] joinVoiceChannel FAILED: ${err && err.message ? err.message : err}`);
            throw err;
        });
};

if (Player) {
    const originalSendServerUpdate = Player.prototype.sendServerUpdate;
    Player.prototype.sendServerUpdate = function(connection) {
        dlog(`[LAVALINK PLAYER DEBUG] sendServerUpdate called | Guild: ${this.guildId}`);
        return originalSendServerUpdate.call(this, connection)
            .then(res => {
                dlog("[LAVALINK PLAYER DEBUG] sendServerUpdate finished successfully!");
                return res;
            })
            .catch(err => {
                dlog(`[LAVALINK PLAYER DEBUG] sendServerUpdate failed: ${err && err.message ? err.message : err}`);
                throw err;
            });
    };
}

if (Rest) {
    const originalFetch = Rest.prototype.fetch;
    Rest.prototype.fetch = function(fetchOptions) {
        dlog(`[LAVALINK REST DEBUG] fetch | Endpoint: ${fetchOptions.endpoint} | Method: ${fetchOptions.options && fetchOptions.options.method ? fetchOptions.options.method : "GET"}`);
        return originalFetch.call(this, fetchOptions)
            .then(res => {
                dlog(`[LAVALINK REST DEBUG] fetch SUCCESS | Endpoint: ${fetchOptions.endpoint}`);
                return res;
            })
            .catch(err => {
                dlog(`[LAVALINK REST DEBUG] fetch ERROR | Endpoint: ${fetchOptions.endpoint} | Message: ${err.message}`);
                throw err;
            });
    };
}

if (Connection) {
    const originalSetStateUpdate = Connection.prototype.setStateUpdate;
    Connection.prototype.setStateUpdate = function(data) {
        dlog(`[LAVALINK CONNECTION DEBUG] setStateUpdate called | Guild: ${this.guildId}`);
        const res = originalSetStateUpdate.call(this, data);
        dlog(`[LAVALINK CONNECTION DEBUG] setStateUpdate finished`);
        return res;
    };

    const originalSetServerUpdate = Connection.prototype.setServerUpdate;
    Connection.prototype.setServerUpdate = function(data) {
        dlog(`[LAVALINK CONNECTION DEBUG] setServerUpdate called | Guild: ${this.guildId} | Endpoint: ${data.endpoint}`);
        const res = originalSetServerUpdate.call(this, data);
        dlog(`[LAVALINK CONNECTION DEBUG] setServerUpdate finished | serverUpdate set: ${!!this.serverUpdate} | state: ${this.state}`);
        return res;
    };
}

// Patch Shoukaku's DiscordJS Connector to support both early/late ready event (required for discord.js-selfbot-v13)
if (Connectors.DiscordJS) {
    Connectors.DiscordJS.prototype.listen = function(nodes) {
        if (this.client.user && this.client.user.id) {
            dlog(`[LAVALINK PATCH] Client is already ready. User ID: ${this.client.user.id}. Initializing Shoukaku nodes immediately.`);
            this.ready(nodes);
        } else {
            dlog("[LAVALINK PATCH] Client is not ready yet. Waiting for 'ready' event.");
            this.client.once("ready", () => {
                dlog(`[LAVALINK PATCH] ready event fired. User ID: ${this.client.user.id}. Initializing Shoukaku nodes.`);
                this.ready(nodes);
            });
        }
        this.client.on("raw", (packet) => {
            if (DEBUG && ["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(packet.t)) {
                if (this.manager && this.manager.connections && this.manager.connections.has(packet.d.guild_id)) {
                    // Note: this line logs session IDs — only fires when DEBUG_LAVALINK is on.
                    dlog(`[LAVALINK GATEWAY RAW] Packet: ${packet.t} | Guild: ${packet.d.guild_id}`);
                }
            }
            this.raw(packet);
        });
    };

    Connectors.DiscordJS.prototype.sendPacket = function(shardId, payload, important) {
        // Do NOT log payload contents — VOICE_STATE_UPDATE contains session IDs.
        dlog(`[LAVALINK SEND PACKET] Shard: ${shardId} | Op: ${payload && payload.op !== undefined ? payload.op : "?"}`);
        const shard = this.client.ws.shards.get(shardId);
        if (!shard) {
            dlog(`[LAVALINK SEND PACKET] ERROR: Shard ${shardId} not found in client.ws.shards!`);
            return;
        }
        try {
            // Preserve upstream return semantics — some Shoukaku versions inspect it.
            return shard.send(payload, important);
        } catch (e) {
            console.error("[LAVALINK SEND PACKET] Error in shard.send():", e && e.message ? e.message : e);
            throw e;
        }
    };
}

const LAVALINK_HOST = process.env.LAVALINK_HOST || "disabled";
const LAVALINK_PORT = process.env.LAVALINK_PORT || "19133";
const LAVALINK_PASS = process.env.LAVALINK_PASSWORD;

// Fail-fast if the host is set but no password is provided. Previously the code
// defaulted to a hardcoded shared secret and shipped that in the repo.
if (LAVALINK_HOST !== "disabled" && process.env.DISABLE_LAVALINK !== "true" && !LAVALINK_PASS) {
    throw new Error(
        "[LAVALINK] LAVALINK_HOST is configured but LAVALINK_PASSWORD is not set. " +
        "Set LAVALINK_PASSWORD in your environment, or set DISABLE_LAVALINK=true / LAVALINK_HOST=disabled to skip Lavalink."
    );
}

const Nodes = [{
    name: "Khonshu",
    url: `${LAVALINK_HOST}:${LAVALINK_PORT}`,
    auth: LAVALINK_PASS || ""
}];

let shoukaku = null;
let nodeConnected = false;

/**
 * Initialize Shoukaku with the Discord client
 * @param {Object} client - discord.js-selfbot-v13 Client
 */
function init(client) {
    if (process.env.DISABLE_LAVALINK === "true" || LAVALINK_HOST === "disabled") {
        console.log("[LAVALINK] Lavalink is explicitly disabled via environment variables. Using local E2EE playback.");
        nodeConnected = false;
        return null;
    }

    shoukaku = new Shoukaku(new Connectors.DiscordJS(client), Nodes, {
        moveOnDisconnect: false,
        resumable: false,
        resumableTimeout: 30,
        reconnectTries: 50,
        restTimeout: 15,
        voiceConnectionTimeout: 10
    });

    shoukaku.on("ready", (name) => {
        console.log(`[LAVALINK] Node "${name}" connected and ready!`);
        nodeConnected = true;
    });

    shoukaku.on("error", (name, error) => {
        console.error(`[LAVALINK] Node "${name}" error:`, error && error.message ? error.message : error);
    });

    shoukaku.on("close", (name, code, reason) => {
        console.log(`[LAVALINK] Node "${name}" closed: ${code} - ${reason}`);
        nodeConnected = false;
    });

    // Previously this handler called process.exit(1), which meant any Lavalink
    // hiccup killed the entire bot process. Now we log, flip the availability
    // flag, and let commands fall back to the ffmpeg pipeline on next $play.
    shoukaku.on("disconnect", (name, players, moved) => {
        console.log(`[LAVALINK] Node "${name}" disconnected. Moved: ${moved}. Node marked unavailable; Shoukaku will attempt reconnect.`);
        nodeConnected = false;
    });

    return shoukaku;
}

/**
 * Get the Shoukaku instance
 */
function getShoukaku() {
    return shoukaku;
}

/**
 * Get an available Lavalink node. Falls back to the first node in the internal
 * map if the configured resolver is missing (Shoukaku API drift).
 */
function getNode() {
    if (!shoukaku) return null;
    try {
        const resolver = shoukaku.options && shoukaku.options.nodeResolver;
        if (typeof resolver === "function") {
            const node = resolver(shoukaku.nodes);
            if (node) return node;
        }
    } catch (_) {}
    // Fallback: pick the first ready node.
    if (shoukaku.nodes && typeof shoukaku.nodes.values === "function") {
        for (const node of shoukaku.nodes.values()) {
            if (node) return node;
        }
    }
    return null;
}

/**
 * Search for a track via Lavalink
 * @param {string} query - Search query or YouTube URL
 * @returns {Promise<Object|null>} First matching track
 */
async function searchTrack(query) {
    const node = getNode();
    if (!node) {
        console.log("[LAVALINK] No nodes available");
        return null;
    }

    try {
        // If it's a URL, load directly. Otherwise, search via the configured engine.
        // Match `http://` / `https://` explicitly so strings like `httpsomething` don't count.
        const isUrl = /^https?:\/\//i.test(query);
        const identifier = isUrl ? query : `${process.env.SEARCH_ENGINE || "scsearch"}:${query}`;
        dlog(`[LAVALINK] Searching: ${identifier}`);

        const result = await node.rest.resolve(identifier);
        if (!result) {
            console.log("[LAVALINK] No result returned");
            return null;
        }

        dlog(`[LAVALINK] Result type: ${result.loadType}`);

        switch (result.loadType) {
            case "track":
            case "short":
                console.log(`[LAVALINK] Track: ${result.data.info.title} by ${result.data.info.author}`);
                return result.data;
            case "search":
                if (result.data.length > 0) {
                    console.log(`[LAVALINK] Search result: ${result.data[0].info.title} by ${result.data[0].info.author}`);
                    return result.data[0];
                }
                break;
            case "playlist":
                if (result.data.tracks && result.data.tracks.length > 0) {
                    console.log(`[LAVALINK] Playlist: ${result.data.info.name} (${result.data.tracks.length} tracks)`);
                    return result.data.tracks[0];
                }
                break;
            case "empty":
                console.log("[LAVALINK] No tracks found");
                break;
            case "error":
                console.log(`[LAVALINK] Error: ${result.data.message}`);
                break;
        }
    } catch (e) {
        console.log(`[LAVALINK] Search error: ${e.message}`);
    }
    return null;
}

async function joinChannel(guildId, channelId, shardId = 0) {
    if (!shoukaku) throw new Error("Shoukaku not initialized");

    console.log(`[LAVALINK] Joining voice channel: ${channelId} in guild: ${guildId}`);

    // Check if already connected
    const existing = shoukaku.players.get(guildId);
    if (existing) {
        console.log("[LAVALINK] Already have a player for this guild");
        return existing;
    }

    // Set a 10-second timeout to join the voice channel to prevent hanging indefinitely.
    // If it times out, clean up the pending join before rejecting so we don't leave a ghost player.
    let timeoutId;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error("Lavalink voice connection setup timed out (10s)"));
        }, 10000);
    });

    const joinPromise = shoukaku.joinVoiceChannel({
        guildId: guildId,
        channelId: channelId,
        shardId: shardId,
        deaf: false
    });

    // If the underlying join settles AFTER we've already timed out, catch the
    // leaked player and evict it instead of letting it live in the players map.
    joinPromise.then(async (player) => {
        if (timedOut) {
            try {
                console.log("[LAVALINK] Late join arrived after timeout — evicting ghost player.");
                if (player && player.guildId) {
                    await shoukaku.leaveVoiceChannel(player.guildId);
                }
            } catch (_) {}
        }
    }, () => { /* joinPromise already handled below */ });

    try {
        const player = await Promise.race([joinPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        console.log("[LAVALINK] Voice channel joined via Lavalink!");
        return player;
    } catch (err) {
        clearTimeout(timeoutId);
        console.log(`[LAVALINK] Failed to join voice channel: ${err.message}. Cleaning up connection...`);
        try {
            await shoukaku.leaveVoiceChannel(guildId);
        } catch (cleanupErr) {
            console.log(`[LAVALINK] Cleanup error: ${cleanupErr.message}`);
        }
        throw err;
    }
}

/**
 * Play a track on a Shoukaku player
 * @param {Object} player - Shoukaku player
 * @param {Object} track - Track from searchTrack()
 * @param {number} volume - Volume 0-100
 */
async function playTrack(player, track, volume = 100) {
    if (!track || !track.encoded) {
        throw new Error("[LAVALINK] playTrack called without a valid track.encoded string");
    }
    console.log(`[LAVALINK] Playing: ${track.info && track.info.title ? track.info.title : "(unknown title)"}`);
    // Shoukaku v4 / Lavalink v4 requires { track: { encoded: "..." } }
    await player.playTrack({ track: { encoded: track.encoded } });

    // Set volume (Lavalink uses 0-1000, we use 0-100)
    try {
        await player.setGlobalVolume(volume);
    } catch (e) {
        console.log(`[LAVALINK] Volume set warning: ${e.message}`);
    }
}

/**
 * Leave a voice channel
 * @param {string} guildId
 */
async function leaveChannel(guildId) {
    if (!shoukaku) return;
    try {
        await shoukaku.leaveVoiceChannel(guildId);
        console.log("[LAVALINK] Left voice channel");
    } catch (e) {
        console.log(`[LAVALINK] Leave error: ${e.message}`);
    }
}

/**
 * Get the player for a guild
 * @param {string} guildId
 * @returns {Object|undefined} Shoukaku player
 */
function getPlayer(guildId) {
    if (!shoukaku) return undefined;
    return shoukaku.players.get(guildId);
}

/**
 * Check if the Lavalink node is successfully connected and online
 * @returns {boolean}
 */
function isConnected() {
    return nodeConnected;
}

module.exports = {
    init, getShoukaku, getNode, searchTrack,
    joinChannel, playTrack, leaveChannel, getPlayer,
    isConnected
};
