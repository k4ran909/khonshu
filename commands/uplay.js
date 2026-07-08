const strings = require("../strings.json");
const utils = require("../utils");
const YouTube = require("youtube-sr").default;

// YouTube URL pattern
const YT_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;

/**
 * @description User play — mention a user, jump to their VC, and play a song.
 *              Usage: uplay @user <song URL or search query>
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args user mention/ID and song query
 */
module.exports.run = async (client, message, args) => {

    if (args.length < 2) {
        try { await message.channel.send(
            "❌ **Usage:** `uplay @user <song URL or search>`\n" +
            "**Example:** `uplay @Someone https://youtu.be/dQw4w9WgXcQ`"
        ); } catch (_) {}
        return;
    }

    // Extract user ID from mention (<@123456> or <@!123456>) or raw ID
    const userInput = args[0];
    const userIdMatch = userInput.match(/^<@!?(\d+)>$/) || userInput.match(/^(\d{17,20})$/);
    if (!userIdMatch) {
        try { await message.channel.send("❌ Please mention a valid user or provide their ID.\n**Example:** `uplay @Someone <song>`"); } catch (_) {}
        return;
    }
    const targetUserId = userIdMatch[1];
    const query = args.slice(1).join(" ");

    // Find the user's voice channel across all guilds
    let voiceChannel = null;
    let targetGuild = null;
    let foundInGuild = null;

    for (const [, guild] of client.guilds.cache) {
        try {
            const member = guild.members.cache.get(targetUserId);
            if (member) {
                foundInGuild = guild.name;
                if (member.voice && member.voice.channel) {
                    voiceChannel = member.voice.channel;
                    targetGuild = guild;
                    break;
                }
            }
        } catch (_) {}
    }

    if (!voiceChannel && !foundInGuild) {
        for (const [, guild] of client.guilds.cache) {
            try {
                const member = await guild.members.fetch(targetUserId).catch(() => null);
                if (member) {
                    foundInGuild = guild.name;
                    if (member.voice && member.voice.channel) {
                        voiceChannel = member.voice.channel;
                        targetGuild = guild;
                        break;
                    }
                }
            } catch (_) {}
        }
    }

    if (!foundInGuild) {
        try { await message.channel.send(`❌ <@${targetUserId}> is not in any mutual server.`); } catch (_) {}
        return;
    }
    if (!voiceChannel) {
        try { await message.channel.send(`❌ <@${targetUserId}> is not in any voice channel right now.`); } catch (_) {}
        return;
    }

    utils.log(`[UPLAY] Target user <${targetUserId}> found in ${targetGuild.name} > ${voiceChannel.name}`);

    const song = await resolveSong(query);
    if (!song) {
        try { await message.channel.send("❌ No results found for your query."); } catch (_) {}
        return;
    }
    song.requestedby = message.author.username;

    // Session routing — same principle as $rplay: if an existing session runs in a
    // DIFFERENT guild/VC, tear it down and rebuild at the target user's VC.
    utils.log(`[UPLAY] Got: "${song.title}" — joining ${voiceChannel.name} in ${targetGuild.name}...`);
    let serverQueue = global.queue.get("queue");

    if (serverQueue && sessionMatchesTarget(serverQueue, targetGuild, voiceChannel)) {
        await appendToActiveSession(client, message, serverQueue, song, targetGuild, voiceChannel);
        return;
    }

    if (serverQueue) {
        utils.log(`[UPLAY] Tearing down existing session (${serverQueue.voiceChannel ? serverQueue.voiceChannel.name : "?"}) to move to ${voiceChannel.name}`);
        await teardownSession(serverQueue);
    }

    await startFreshSession(client, message, targetGuild, voiceChannel, song);
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

    utils.log(`[UPLAY] Searching: "${query}"`);
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
        console.error("[UPLAY] Error joining/playing:", e);
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
        utils.log(`[UPLAY] Queue was idle, starting playback: ${song.title}`);
        try {
            const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${guild.name}** > **${voiceChannel.name}**`);
            song._discordMsg = sentMsg;
        } catch (_) {}
        await utils.play(song);
    } else {
        utils.log(`[UPLAY] Added to queue: ${song.title}`);
        try {
            const sentMsg = await message.channel.send(`✅ '**${song.title}**' has been added to the queue`);
            song._discordMsg = sentMsg;
        } catch (_) {}
    }
}

module.exports.names = {
    list: ["uplay", "up", "userplay"]
};
