/**
 * Lavalink Manager — Full Shoukaku integration for audio playback
 * Lavalink handles YouTube extraction on its server + streams audio to Discord
 */

const { Shoukaku, Connectors, Connection, Rest, Player } = require("shoukaku");

// Debug patch Shoukaku joinVoiceChannel state changes
const originalJoinVoiceChannel = Shoukaku.prototype.joinVoiceChannel;
Shoukaku.prototype.joinVoiceChannel = function(options) {
    console.log(`[LAVALINK SHOUKAKU DEBUG] joinVoiceChannel called | Guild: ${options.guildId} | Channel: ${options.channelId}`);
    return originalJoinVoiceChannel.call(this, options)
        .then(player => {
            console.log(`[LAVALINK SHOUKAKU DEBUG] joinVoiceChannel succeeded! Player created for guild: ${player.guildId}`);
            return player;
        })
        .catch(err => {
            console.error(`[LAVALINK SHOUKAKU DEBUG] joinVoiceChannel FAILED:`, err);
            throw err;
        });
};

// Debug patch Shoukaku Player sendServerUpdate
if (Player) {
    const originalSendServerUpdate = Player.prototype.sendServerUpdate;
    Player.prototype.sendServerUpdate = function(connection) {
        console.log(`[LAVALINK PLAYER DEBUG] sendServerUpdate called | Guild: ${this.guildId} | Connection Session ID: ${connection.sessionId}`);
        return originalSendServerUpdate.call(this, connection)
            .then(res => {
                console.log("[LAVALINK PLAYER DEBUG] sendServerUpdate finished successfully!");
                return res;
            })
            .catch(err => {
                console.error("[LAVALINK PLAYER DEBUG] sendServerUpdate failed:", err);
                throw err;
            });
    };
}

// Debug patch Shoukaku Rest requests
if (Rest) {
    const originalFetch = Rest.prototype.fetch;
    Rest.prototype.fetch = function(fetchOptions) {
        console.log(`[LAVALINK REST DEBUG] fetch called | Endpoint: ${fetchOptions.endpoint} | Method: ${fetchOptions.options?.method || "GET"} | Session ID: ${this.sessionId}`);
        return originalFetch.call(this, fetchOptions)
            .then(res => {
                console.log(`[LAVALINK REST DEBUG] fetch SUCCESS | Endpoint: ${fetchOptions.endpoint}`);
                return res;
            })
            .catch(err => {
                console.error(`[LAVALINK REST DEBUG] fetch ERROR | Endpoint: ${fetchOptions.endpoint} | Message: ${err.message}`);
                throw err;
            });
    };
}

// Debug patch Shoukaku Connection state changes to isolate UDP/WebRTC connection failures
if (Connection) {
    const originalSetStateUpdate = Connection.prototype.setStateUpdate;
    Connection.prototype.setStateUpdate = function(data) {
        console.log(`[LAVALINK CONNECTION DEBUG] setStateUpdate called | Guild: ${this.guildId} | Session ID: ${data.session_id}`);
        const res = originalSetStateUpdate.call(this, data);
        console.log(`[LAVALINK CONNECTION DEBUG] setStateUpdate finished | Current Session ID: ${this.sessionId}`);
        return res;
    };

    const originalSetServerUpdate = Connection.prototype.setServerUpdate;
    Connection.prototype.setServerUpdate = function(data) {
        console.log(`[LAVALINK CONNECTION DEBUG] setServerUpdate called | Guild: ${this.guildId} | Endpoint: ${data.endpoint} | Session ID is set: ${!!this.sessionId}`);
        const res = originalSetServerUpdate.call(this, data);
        console.log(`[LAVALINK CONNECTION DEBUG] setServerUpdate finished | serverUpdate set: ${!!this.serverUpdate} | state: ${this.state}`);
        return res;
    };
}

// Patch Shoukaku's DiscordJS Connector to support both early/late ready event (required for discord.js-selfbot-v13)
if (Connectors.DiscordJS) {
    Connectors.DiscordJS.prototype.listen = function(nodes) {
        if (this.client.user && this.client.user.id) {
            console.log(`[LAVALINK PATCH] Client is already ready. User ID: ${this.client.user.id}. Initializing Shoukaku nodes immediately.`);
            this.ready(nodes);
        } else {
            console.log("[LAVALINK PATCH] Client is not ready yet. Waiting for 'ready' event.");
            this.client.once("ready", () => {
                console.log(`[LAVALINK PATCH] ready event fired. User ID: ${this.client.user.id}. Initializing Shoukaku nodes.`);
                this.ready(nodes);
            });
        }
        this.client.on("raw", (packet) => {
            if (["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(packet.t)) {
                // Only log if the packet is for a guild we are actively connecting/connected to!
                if (this.manager && this.manager.connections && this.manager.connections.has(packet.d.guild_id)) {
                    console.log(`[LAVALINK GATEWAY RAW] Packet: ${packet.t} | Guild: ${packet.d.guild_id} | User: ${packet.d.user_id || "none"} | Session: ${packet.d.session_id || "none"} | Manager ID: ${this.manager?.id}`);
                }
            }
            this.raw(packet);
        });
    };

    Connectors.DiscordJS.prototype.sendPacket = function(shardId, payload, important) {
        console.log(`[LAVALINK SEND PACKET] Shard: ${shardId} | Payload: ${JSON.stringify(payload)} | Client WS Status: ${this.client.ws?.status}`);
        const shard = this.client.ws.shards.get(shardId);
        if (shard) {
            try {
                shard.send(payload, important);
                console.log("[LAVALINK SEND PACKET] Successfully called shard.send()");
            } catch (e) {
                console.error("[LAVALINK SEND PACKET] Error in shard.send():", e);
            }
        } else {
            console.log(`[LAVALINK SEND PACKET] ERROR: Shard ${shardId} not found in client.ws.shards!`);
        }
    };
}

const LAVALINK_HOST = process.env.LAVALINK_HOST || "disabled";
const LAVALINK_PORT = process.env.LAVALINK_PORT || "19133";
const LAVALINK_PASS = process.env.LAVALINK_PASSWORD || "RavenLava_19133";

const Nodes = [{
    name: "Khonshu",
    url: `${LAVALINK_HOST}:${LAVALINK_PORT}`,
    auth: LAVALINK_PASS
}];

let shoukaku = null;
let nodeConnected = false;

/**
 * Initialize Shoukaku with the Discord client
 * @param {Object} client - discord.js-selfbot-v13 Client
 */
function init(client) {
    if (process.env.DISABLE_LAVALINK === "true" || process.env.LAVALINK_HOST === "disabled") {
        console.log("[LAVALINK] Lavalink is explicitly disabled via environment variables. Using local E2EE playback.");
        nodeConnected = false;
        return null;
    }

    shoukaku = new Shoukaku(new Connectors.DiscordJS(client), Nodes, {
        moveOnDisconnect: false,
        resumable: false,
        resumableTimeout: 30,
        reconnectTries: 3,
        restTimeout: 15,
        voiceConnectionTimeout: 10
    });

    shoukaku.on("ready", (name) => {
        console.log(`[LAVALINK] Node "${name}" connected and ready!`);
        nodeConnected = true;
    });

    shoukaku.on("error", (name, error) => {
        console.error(`[LAVALINK] Node "${name}" error:`, error);
    });

    shoukaku.on("close", (name, code, reason) => {
        console.log(`[LAVALINK] Node "${name}" closed: ${code} - ${reason}`);
        nodeConnected = false;
    });

    shoukaku.on("disconnect", (name, players, moved) => {
        console.log(`[LAVALINK] Node "${name}" disconnected. Moved: ${moved}`);
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
 * Get an available Lavalink node
 */
function getNode() {
    if (!shoukaku) return null;
    return shoukaku.options.nodeResolver(shoukaku.nodes);
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
        // If it's a URL, load directly. Otherwise, search YouTube
        const identifier = query.startsWith("http") ? query : `ytsearch:${query}`;
        console.log(`[LAVALINK] Searching: ${identifier}`);
        
        const result = await node.rest.resolve(identifier);
        if (!result) {
            console.log("[LAVALINK] No result returned");
            return null;
        }

        console.log(`[LAVALINK] Result type: ${result.loadType}`);

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

    // Set a 10-second timeout to join the voice channel to prevent hanging indefinitely
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error("Lavalink voice connection setup timed out (10s)"));
        }, 10000);
    });

    const joinPromise = shoukaku.joinVoiceChannel({
        guildId: guildId,
        channelId: channelId,
        shardId: shardId,
        deaf: false
    });

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
    console.log(`[LAVALINK] Playing: ${track.info.title}`);
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
