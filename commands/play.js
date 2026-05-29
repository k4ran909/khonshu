const strings = require("../strings.json");
const utils = require("../utils");
const YouTube = require("youtube-sr").default;

// ═══════════════════════════════════════════
// Spotify URL Resolver (no API keys needed)
// ═══════════════════════════════════════════
let spotifyGetTracks = null;
let spotifyGetData = null;
try {
    const fetch = require("isomorphic-unfetch");
    const spotify = require("spotify-url-info")(fetch);
    spotifyGetTracks = spotify.getTracks;
    spotifyGetData = spotify.getData;
    utils.log("[SPOTIFY] Spotify resolver loaded successfully.");
} catch (e) {
    console.warn("[SPOTIFY] spotify-url-info not available, Spotify links will be disabled.", e.message);
}

// Spotify URL pattern
const SPOTIFY_REGEX = /^(https?:\/\/)?(open\.spotify\.com)\/(track|playlist|album)\/([a-zA-Z0-9]+)/;

// YouTube URL pattern
const YT_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;

/** 
 * @description Play a song from YouTube search, YouTube URL, or Spotify URL
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args search words or link
 */
module.exports.run = async (client, message, args) => {

    if(!args[0]) return message.channel.send(strings.noArgsSongSearch);

    // Find voice channel - either from guild context or by searching all guilds (for DMs)
    let voiceChannel;

    if (message._isDM) {
        // Dynamic real-time lookup across all guilds to find the owner's active voice channel
        let ownerChannel = null;
        if (global.config.owner) {
            for (const [, guild] of client.guilds.cache) {
                try {
                    const member = guild.members.cache.get(global.config.owner) || await guild.members.fetch(global.config.owner);
                    if (member && member.voice && member.voice.channel) {
                        ownerChannel = member.voice.channel;
                        global.ownerVoiceChannel = ownerChannel; // Sync cache
                        break;
                    }
                } catch (e) {}
            }
        }
        voiceChannel = ownerChannel || global.ownerVoiceChannel;
        if (!voiceChannel) {
            return message.channel.send("❌ You need to be in a voice channel first. Join one and try again.");
        }
    } else {
        voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.channel.send(strings.notInVocal);
    }

    const query = args.join(" ");

    // ───────────────────────────────────────
    // Spotify URL Handler
    // ───────────────────────────────────────
    const spotifyMatch = query.match(SPOTIFY_REGEX);
    if (spotifyMatch && spotifyGetTracks) {
        const spotifyType = spotifyMatch[3]; // track, playlist, or album
        utils.log(`[SPOTIFY] Detected ${spotifyType} URL: ${query}`);

        try {
            await message.channel.send(`🟢 Loading Spotify ${spotifyType}...`);
        } catch (e) {}

        try {
            const tracks = await spotifyGetTracks(query);

            if (!tracks || tracks.length === 0) {
                return message.channel.send("❌ No tracks found from this Spotify link.");
            }

            utils.log(`[SPOTIFY] Resolved ${tracks.length} track(s) from Spotify ${spotifyType}.`);

            // For single tracks, play immediately
            if (spotifyType === "track" || tracks.length === 1) {
                const track = tracks[0];
                const searchQuery = `${track.name} ${track.artists ? track.artists.map(a => a.name).join(" ") : ""}`.trim();
                return await playFromSearch(client, message, voiceChannel, searchQuery);
            }

            // For playlists/albums: play first track immediately, queue the rest in background
            const firstTrack = tracks[0];
            const firstSearch = `${firstTrack.name} ${firstTrack.artists ? firstTrack.artists.map(a => a.name).join(" ") : ""}`.trim();
            
            // Play the first track right away
            await playFromSearch(client, message, voiceChannel, firstSearch);

            // Queue remaining tracks in the background
            const remaining = tracks.slice(1);
            if (remaining.length > 0) {
                try {
                    await message.channel.send(`🟢 Queuing **${remaining.length}** more tracks from Spotify ${spotifyType} in the background...`);
                } catch (e) {}

                // Process in background — don't await
                queueSpotifyTracks(message, remaining).then(async (queued) => {
                    try {
                        await message.channel.send(`✅ Spotify ${spotifyType} loaded! **${queued}/${remaining.length}** tracks added to queue.`);
                    } catch (e) {}
                });
            }

            return;

        } catch (err) {
            console.error("[SPOTIFY] Error resolving Spotify URL:", err);
            return message.channel.send("❌ Failed to load Spotify link. It may be private or invalid.");
        }
    }

    // ───────────────────────────────────────
    // YouTube URL / Search Handler
    // ───────────────────────────────────────
    if (YT_URL_REGEX.test(query)) {
        // Direct YouTube URL
        let url = query, title, duration;
        try {
            const video = await YouTube.getVideo(query);
            if (video) {
                title = video.title;
                duration = Math.floor((video.duration || 0) / 1000);
            } else {
                title = "Unknown Track";
                duration = 0;
            }
        } catch (e) {
            try {
                const results = await YouTube.search(query, { limit: 1 });
                if (results && results.length > 0) {
                    title = results[0].title;
                    duration = Math.floor(results[0].duration / 1000);
                } else {
                    title = "Unknown Track";
                    duration = 0;
                }
            } catch (e2) {
                title = "Unknown Track";
                duration = 0;
            }
        }

        if (title === "Unknown Track") {
            utils.log(`[PLAY] YouTube library failed to resolve metadata for direct link. Trying fallback metadata fetcher...`);
            try {
                const meta = await utils.fetchMetadata(url);
                if (meta && meta.title) {
                    title = meta.title;
                    duration = meta.duration;
                    utils.log(`[PLAY] Fallback metadata lookup success! Title: "${title}", Duration: ${duration}s`);
                }
            } catch (metaError) {
                utils.log(`[PLAY] Fallback metadata lookup failed: ${metaError.message}`);
            }
        }

        const song = { title, duration, url, requestedby: message.author.username };
        return await addAndPlay(client, message, voiceChannel, song);

    } else {
        // Search query
        return await playFromSearch(client, message, voiceChannel, query);
    }
};

/**
 * @description Searches YouTube for a query and plays/queues the top result
 */
async function playFromSearch(client, message, voiceChannel, query) {
    utils.log(`Looking for music details: "${query}"`);

    try {
        const results = await YouTube.search(query, { limit: 1 });
        if (!results || results.length === 0) {
            return message.channel.send("❌ No matches found for your query.");
        }

        const song = {
            title: results[0].title,
            duration: Math.floor(results[0].duration / 1000),
            url: `https://www.youtube.com/watch?v=${results[0].id}`,
            requestedby: message.author.username
        };

        return await addAndPlay(client, message, voiceChannel, song);
    } catch (e) {
        console.error("YouTube search error:", e.message);
        utils.log(`[PLAY] Standard YouTube search failed. Trying fallback search resolver...`);
        try {
            const fallbackResult = await utils.fetchSearch(query);
            if (fallbackResult && fallbackResult.url) {
                const song = {
                    title: fallbackResult.title,
                    duration: fallbackResult.duration,
                    url: fallbackResult.url,
                    requestedby: message.author.username
                };
                utils.log(`[PLAY] Fallback search success! Found: "${song.title}"`);
                return await addAndPlay(client, message, voiceChannel, song);
            }
        } catch (searchErr) {
            utils.log(`[PLAY] Fallback search failed: ${searchErr.message}`);
        }
        return message.channel.send("❌ Error searching for the track.");
    }
}

/**
 * @description Adds a song to the queue and starts playback if nothing is playing
 */
async function addAndPlay(client, message, voiceChannel, song) {
    utils.log(`Got music details: "${song.title}", preparing the music to be played...`);

    let serverQueue = queue.get("queue");

    if (serverQueue && serverQueue.isVideo) {
        utils.log("[PLAY] Stopping active video stream session to switch to standard audio.");
        if (serverQueue.streamPlay && serverQueue.streamPlay.command) {
            try { serverQueue.streamPlay.command.kill(); } catch (e) {}
        }
        if (serverQueue.streamer) {
            try { serverQueue.streamer.leaveVoice(); } catch (e) {}
        }
        queue.delete("queue");
        serverQueue = null;
    }

    if (!serverQueue || !serverQueue.songs) {
        const queueConstruct = {
            textchannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: null,
            songs: [],
            volume: global.pendingVolume || 1,
            playing: true,
            loop: false,
            skipped: false,
            currentResource: null,
            ffmpegProcess: null,
            filters: [],          // DSP audio filters
            restarting: false,    // Flag for filter restart
            disconnectTimer: null // Auto-disconnect timer
        };

        queue.set("queue", queueConstruct);
        queueConstruct.songs.push(song);

        try {
            const lavalink = require("../lavalink");
            if (lavalink.isConnected()) {
                utils.log("[PLAY] Lavalink is connected, skipping @discordjs/voice connection. utils.play will handle voice connection.");
                try {
                    const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing`);
                    song._discordMsg = sentMsg;
                } catch (e) {}
                await utils.play(queueConstruct.songs[0]);
            } else {
                const connection = await utils.joinVChannel(voiceChannel, client);
                queueConstruct.connection = connection;
                try {
                    const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing`);
                    song._discordMsg = sentMsg;
                } catch (e) {}
                await utils.play(queueConstruct.songs[0]);
            }
        } catch (e) {
            console.error("Error joining voice/playing:", e);
            queue.delete("queue");
            return message.channel.send("❌ Failed to join voice channel or play track.");
        }
    } else {
        // Clear auto-disconnect timer if new song is added
        if (serverQueue.disconnectTimer) {
            clearTimeout(serverQueue.disconnectTimer);
            serverQueue.disconnectTimer = null;
        }

        serverQueue.songs.push(song);

        // If queue was empty (e.g. after a failed track), start playback
        if (serverQueue.songs.length === 1) {
            utils.log(`[PLAY] Queue was idle, starting playback: ${song.title}`);
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing`);
                song._discordMsg = sentMsg;
            } catch (e) {}
            await utils.play(song);
        } else {
            utils.log(`Added music to the queue : ${song.title}`);
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' has been added to the queue`);
                song._discordMsg = sentMsg;
            } catch (e) {}
        }
    }
}

/**
 * @description Background processor — resolves Spotify tracks to YouTube and queues them
 */
async function queueSpotifyTracks(message, tracks) {
    let queued = 0;

    for (const track of tracks) {
        const searchQuery = `${track.name} ${track.artists ? track.artists.map(a => a.name).join(" ") : ""}`.trim();

        try {
            const results = await YouTube.search(searchQuery, { limit: 1 });
            if (results && results.length > 0) {
                const song = {
                    title: results[0].title,
                    duration: Math.floor(results[0].duration / 1000),
                    url: `https://www.youtube.com/watch?v=${results[0].id}`,
                    requestedby: message.author.username
                };

                const serverQueue = queue.get("queue");
                if (!serverQueue) break;  // Queue was destroyed, stop processing

                // Clear auto-disconnect timer since we're adding songs
                if (serverQueue.disconnectTimer) {
                    clearTimeout(serverQueue.disconnectTimer);
                    serverQueue.disconnectTimer = null;
                }

                serverQueue.songs.push(song);
                queued++;
                utils.log(`[SPOTIFY] Queued: ${song.title} (${queued}/${tracks.length})`);
            }
        } catch (e) {
            utils.log(`[SPOTIFY] Standard search failed for: "${searchQuery}". Trying fallback...`);
            try {
                const fallbackResult = await utils.fetchSearch(searchQuery);
                if (fallbackResult && fallbackResult.url) {
                    const song = {
                        title: fallbackResult.title,
                        duration: fallbackResult.duration,
                        url: fallbackResult.url,
                        requestedby: message.author.username
                    };
                    const serverQueue = queue.get("queue");
                    if (serverQueue) {
                        if (serverQueue.disconnectTimer) {
                            clearTimeout(serverQueue.disconnectTimer);
                            serverQueue.disconnectTimer = null;
                        }
                        serverQueue.songs.push(song);
                        queued++;
                        utils.log(`[SPOTIFY] Queued via fallback: ${song.title} (${queued}/${tracks.length})`);
                    }
                } else {
                    utils.log(`[SPOTIFY] Failed to resolve: ${searchQuery}`);
                }
            } catch (fallbackErr) {
                utils.log(`[SPOTIFY] Failed to resolve: ${searchQuery} - ${fallbackErr.message}`);
            }
        }

        // Small delay between searches to avoid rate-limiting
        await new Promise(r => setTimeout(r, 500));
    }

    return queued;
}

module.exports.names = {
    list: ["play", "p"]
};