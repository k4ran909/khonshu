const strings = require("../strings.json");
const utils = require("../utils");
const YouTube = require("youtube-sr").default;

// YouTube URL pattern
const YT_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;

// Discord voice-channel type sentinels (v13 string form + gateway numeric form).
const VOICE_CHANNEL_TYPES = new Set(["GUILD_VOICE", "GUILD_STAGE_VOICE", 2, 13]);

/**
 * @description Remote play — play music in any guild/voice channel by providing IDs directly.
 *              Usage: rplay <guild_id> <voice_channel_id> <song URL or search query>
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args guild_id, voice_channel_id, and song query
 */
module.exports.run = async (client, message, args) => {

    if (args.length < 3) {
        try { await message.channel.send(
            "❌ **Usage:** `rplay <guild_id> <voice_channel_id> <song URL or search>`\n" +
            "**Example:** `rplay 123456789 987654321 https://youtu.be/dQw4w9WgXcQ`"
        ); } catch (_) {}
        return;
    }

    const guildId = args[0];
    const channelId = args[1];
    const query = args.slice(2).join(" ");

    // Resolve the guild (cache first, then fetch as fallback)
    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
        try { guild = await client.guilds.fetch(guildId); } catch (_) {}
    }
    if (!guild) {
        try { await message.channel.send(`❌ Bot is not in a server with ID: \`${guildId}\``); } catch (_) {}
        return;
    }

    // Resolve the voice channel (cache first, then fetch as fallback)
    let voiceChannel = guild.channels.cache.get(channelId);
    if (!voiceChannel) {
        try { voiceChannel = await guild.channels.fetch(channelId); } catch (_) {}
    }
    if (!voiceChannel) {
        try { await message.channel.send(`❌ No channel found with ID: \`${channelId}\` in **${guild.name}**`); } catch (_) {}
        return;
    }
    if (!VOICE_CHANNEL_TYPES.has(voiceChannel.type)) {
        try { await message.channel.send(`❌ \`${channelId}\` is not a voice channel. It's a ${voiceChannel.type} channel.`); } catch (_) {}
        return;
    }

    utils.log(`[RPLAY] Remote play in ${guild.name} > ${voiceChannel.name} | Query: "${query}"`);

    // ───────────────────────────────────────
    // Resolve the song (YouTube URL or search)
    // ───────────────────────────────────────
    const song = await resolveSong(query);
    if (!song) {
        try { await message.channel.send("❌ No results found for your query."); } catch (_) {}
        return;
    }
    song.requestedby = message.author.username;

    // ───────────────────────────────────────
    // Session routing — key fix vs. previous behavior:
    // If a session already exists in a DIFFERENT guild/VC than the target, tear it
    // down cleanly BEFORE starting fresh at the target. Prevents the surprise-append.
    // ───────────────────────────────────────
    utils.log(`[RPLAY] Got: "${song.title}" — joining ${voiceChannel.name}...`);
    let serverQueue = global.queue.get("queue");

    if (serverQueue && sessionMatchesTarget(serverQueue, guild, voiceChannel)) {
        // Same target — just append to the current queue.
        await appendToActiveSession(client, message, serverQueue, song, guild, voiceChannel);
        return;
    }

    // Different target (or no session, or a video session) — tear down and rebuild fresh.
    if (serverQueue) {
        utils.log(`[RPLAY] Tearing down existing session (${serverQueue.voiceChannel ? serverQueue.voiceChannel.name : "?"}) to move to ${voiceChannel.name}`);
        await teardownSession(serverQueue);
    }

    await startFreshSession(client, message, guild, voiceChannel, song);
};

function sessionMatchesTarget(serverQueue, guild, voiceChannel) {
    if (serverQueue.isVideo) return false;
    if (!serverQueue.voiceChannel) return false;
    if (serverQueue.voiceChannel.guild.id !== guild.id) return false;
    return serverQueue.voiceChannel.id === voiceChannel.id;
}

async function teardownSession(serverQueue) {
    if (serverQueue.disconnectTimer) {
        try { clearTimeout(serverQueue.disconnectTimer); } catch (_) {}
    }
    if (serverQueue.streamPlay && serverQueue.streamPlay.command) {
        try { serverQueue.streamPlay.command.kill(); } catch (_) {}
    }
    if (serverQueue.streamer) {
        try { serverQueue.streamer.leaveVoice(); } catch (_) {}
    }
    if (serverQueue.ffmpegProcess) {
        try { serverQueue.ffmpegProcess.kill(); } catch (_) {}
    }
    if (serverQueue.useLavalink && serverQueue.guildId) {
        try {
            const lavalink = require("../lavalink");
            await lavalink.leaveChannel(serverQueue.guildId);
        } catch (_) {}
    } else {
        if (serverQueue.player) { try { serverQueue.player.stop(true); } catch (_) {} }
        if (serverQueue.connection) { try { serverQueue.connection.destroy(); } catch (_) {} }
    }
    global.queue.delete("queue");
}

async function resolveSong(query) {
    if (YT_URL_REGEX.test(query)) {
        const url = query;
        let title = "Unknown Track", duration = 0;
        try {
            const video = await YouTube.getVideo(query);
            if (video) {
                title = video.title;
                duration = Math.floor((video.duration || 0) / 1000);
            }
        } catch (_) {
            try {
                const results = await YouTube.search(query, { limit: 1 });
                if (results && results.length > 0) {
                    title = results[0].title;
                    duration = Math.floor((results[0].duration || 0) / 1000);
                }
            } catch (_) {}
        }
        if (title === "Unknown Track") {
            try {
                const meta = await utils.fetchMetadata(url);
                if (meta && meta.title) { title = meta.title; duration = meta.duration || 0; }
            } catch (_) {}
        }
        return { title, duration, url };
    }

    utils.log(`[RPLAY] Searching: "${query}"`);
    try {
        const results = await YouTube.search(query, { limit: 1 });
        if (results && results.length > 0) {
            return {
                title: results[0].title,
                duration: Math.floor((results[0].duration || 0) / 1000),
                url: `https://www.youtube.com/watch?v=${results[0].id}`
            };
        }
    } catch (_) {}
    try {
        const fallbackResult = await utils.fetchSearch(query);
        if (fallbackResult && fallbackResult.url) {
            return {
                title: fallbackResult.title,
                duration: fallbackResult.duration || 0,
                url: fallbackResult.url
            };
        }
    } catch (_) {}
    return null;
}

async function startFreshSession(client, message, guild, voiceChannel, song) {
    const lavalink = require("../lavalink");
    const useLavalink = lavalink.isConnected();
    const pending = (typeof global.pendingVolume === "number" && Number.isFinite(global.pendingVolume)) ? global.pendingVolume : 1;
    global.pendingVolume = null;

    const queueConstruct = {
        textchannel: message.channel,
        voiceChannel: voiceChannel,
        connection: null,
        guildId: guild.id,
        channelId: voiceChannel.id,
        player: null,
        songs: [song],
        volume: pending,
        playing: true,
        loop: false,
        skipped: false,
        currentResource: null,
        ffmpegProcess: null,
        filters: [],
        restarting: false,
        disconnectTimer: null,
        useLavalink: useLavalink
    };
    global.queue.set("queue", queueConstruct);

    try {
        if (useLavalink) {
            const player = await lavalink.joinChannel(guild.id, voiceChannel.id, 0);
            queueConstruct.player = player;
        } else {
            queueConstruct.connection = await utils.joinVChannel(voiceChannel, client);
        }
        try {
            const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${guild.name}** > **${voiceChannel.name}**`);
            song._discordMsg = sentMsg;
        } catch (_) {}
        await utils.play(queueConstruct.songs[0]);
    } catch (e) {
        console.error("[RPLAY] Error joining/playing:", e);
        global.queue.delete("queue");
        try { await message.channel.send(`❌ Failed to join **${voiceChannel.name}**: ${e && e.message ? e.message : e}`); } catch (_) {}
    }
}

async function appendToActiveSession(client, message, serverQueue, song, guild, voiceChannel) {
    if (serverQueue.disconnectTimer) {
        try { clearTimeout(serverQueue.disconnectTimer); } catch (_) {}
        serverQueue.disconnectTimer = null;
    }

    serverQueue.songs.push(song);

    if (serverQueue.songs.length === 1) {
        utils.log(`[RPLAY] Queue was idle, starting playback: ${song.title}`);
        try {
            const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${guild.name}** > **${voiceChannel.name}**`);
            song._discordMsg = sentMsg;
        } catch (_) {}
        await utils.play(song);
    } else {
        utils.log(`[RPLAY] Added to queue: ${song.title}`);
        try {
            const sentMsg = await message.channel.send(`✅ '**${song.title}**' has been added to the queue`);
            song._discordMsg = sentMsg;
        } catch (_) {}
    }
}

module.exports.names = {
    list: ["rplay", "rp", "remoteplay"]
};
