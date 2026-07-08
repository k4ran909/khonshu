const strings = require("../strings.json");
const utils = require("../utils");

/**
 * @description Make the bot join/move to the user's current voice channel.
 *              Preserves songs/filters/volume/loop AND whichever pipeline (ffmpeg / Lavalink) was active.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args unused
 */
module.exports.run = async (client, message, args) => {

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
            try { await message.channel.send("❌ You need to be in a voice channel first."); } catch (_) {}
            return;
        }
    } else {
        if (!message.member || !message.member.voice || !message.member.voice.channel) {
            try { await message.channel.send(strings.notInVocal); } catch (_) {}
            return;
        }
        voiceChannel = message.member.voice.channel;
    }

    // ─── Check if the VC is full ───
    if (voiceChannel.userLimit > 0 && voiceChannel.members.size >= voiceChannel.userLimit) {
        utils.log(`[JOIN] VC "${voiceChannel.name}" is full (${voiceChannel.members.size}/${voiceChannel.userLimit})`);
        try {
            const owner = await client.users.fetch(global.config.owner);
            if (owner) {
                await owner.send(`❌ **${voiceChannel.name}** is full (${voiceChannel.members.size}/${voiceChannel.userLimit}). Make some space and try again.`);
            }
        } catch (e) {
            try { await message.channel.send(`❌ **${voiceChannel.name}** is full (${voiceChannel.members.size}/${voiceChannel.userLimit}). Make some space and try again.`); } catch (_) {}
        }
        return;
    }

    const serverQueue = global.queue.get("queue");

    utils.log(`[JOIN] Joining channel: ${voiceChannel.name} (${voiceChannel.id})`);

    if (!serverQueue) {
        return joinFresh(client, message, voiceChannel);
    }

    if (serverQueue.voiceChannel && serverQueue.voiceChannel.id === voiceChannel.id) {
        try { await message.channel.send("✅ Already in your voice channel!"); } catch (_) {}
        return;
    }

    // Same-guild move OR cross-guild move — both go through the same rebuild path,
    // preserving the ORIGINAL pipeline choice (ffmpeg vs Lavalink).
    return moveTo(client, message, serverQueue, voiceChannel);
};

/**
 * Start a fresh session (no existing queue). Pick Lavalink if available, else ffmpeg pipeline.
 */
async function joinFresh(client, message, voiceChannel) {
    try {
        const lavalink = require("../lavalink");
        if (lavalink.isConnected()) {
            utils.log("[JOIN] Lavalink is connected, joining voice channel via Lavalink.");
            const guildId = voiceChannel.guild.id;
            const channelId = voiceChannel.id;
            const player = await lavalink.joinChannel(guildId, channelId, 0);

            const queueConstruct = {
                textchannel: message.channel,
                voiceChannel: voiceChannel,
                connection: null,
                guildId: guildId,
                channelId: channelId,
                player: player,
                songs: [],
                volume: 1,
                playing: false,
                loop: false,
                skipped: false,
                currentResource: null,
                ffmpegProcess: null,
                filters: [],
                restarting: false,
                disconnectTimer: null,
                useLavalink: true
            };
            global.queue.set("queue", queueConstruct);
            try { await message.channel.send(strings.joinMsg); } catch (_) {}
            return;
        }

        const connection = await utils.joinVChannel(voiceChannel, client);
        const queueConstruct = {
            textchannel: message.channel,
            voiceChannel: voiceChannel,
            connection: connection,
            player: null,
            songs: [],
            volume: 1,
            playing: false,
            loop: false,
            skipped: false,
            currentResource: null,
            ffmpegProcess: null,
            filters: [],
            restarting: false,
            disconnectTimer: null,
            useLavalink: false
        };
        global.queue.set("queue", queueConstruct);
        try { await message.channel.send(strings.joinMsg); } catch (_) {}
    } catch (e) {
        console.error("Error joining voice channel:", e);
        try { await message.channel.send("❌ Failed to join voice channel."); } catch (_) {}
    }
}

/**
 * Tear down the existing session and rebuild it in `voiceChannel`, preserving:
 *   - songs / filters / volume / loop
 *   - the pipeline choice (ffmpeg vs Lavalink)
 */
async function moveTo(client, message, serverQueue, voiceChannel) {
    const crossGuild = !serverQueue.voiceChannel || serverQueue.voiceChannel.guild.id !== voiceChannel.guild.id;
    utils.log(`[JOIN] Moving ${crossGuild ? "across guilds" : "within guild"}: ${serverQueue.voiceChannel ? serverQueue.voiceChannel.name : "?"} → ${voiceChannel.name}`);

    // 1. SAVE everything FIRST before touching the old player.
    const songs = [...(serverQueue.songs || [])];
    const filters = serverQueue.filters ? [...serverQueue.filters] : [];
    const vol = serverQueue.volume;
    const loop = !!serverQueue.loop;
    const wasLavalink = !!serverQueue.useLavalink;
    const oldGuildId = serverQueue.guildId;

    // 2. Clear auto-disconnect timer.
    if (serverQueue.disconnectTimer) clearTimeout(serverQueue.disconnectTimer);

    // 3. DELETE queue FIRST so the old player's Idle handler exits early.
    global.queue.delete("queue");

    // 4. Now stop the old pipeline.
    if (serverQueue.ffmpegProcess) { try { serverQueue.ffmpegProcess.kill(); } catch (_) {} }
    if (wasLavalink) {
        try {
            const lavalink = require("../lavalink");
            if (oldGuildId) await lavalink.leaveChannel(oldGuildId);
        } catch (e) { utils.log(`[JOIN] Lavalink teardown error: ${e.message}`); }
    } else {
        if (serverQueue.player) { try { serverQueue.player.stop(true); } catch (_) {} }
        if (serverQueue.connection) { try { serverQueue.connection.destroy(); } catch (_) {} }
    }

    // 5. Rebuild — preserve the original pipeline choice.
    const guildId = voiceChannel.guild.id;
    const channelId = voiceChannel.id;

    try {
        if (wasLavalink) {
            const lavalink = require("../lavalink");
            if (!lavalink.isConnected()) {
                try { await message.channel.send("❌ Lavalink node is not connected — cannot move Lavalink session."); } catch (_) {}
                return;
            }
            const newPlayer = await lavalink.joinChannel(guildId, channelId, 0);

            const queueConstruct = {
                textchannel: message.channel,
                voiceChannel: voiceChannel,
                connection: null,
                guildId: guildId,
                channelId: channelId,
                player: newPlayer,
                songs: songs,
                volume: vol,
                playing: true,
                loop: loop,
                skipped: false,
                currentResource: null,
                ffmpegProcess: null,
                filters: filters,
                restarting: false,
                disconnectTimer: null,
                useLavalink: true
            };
            global.queue.set("queue", queueConstruct);

            if (queueConstruct.songs[0]) {
                await utils.play(queueConstruct.songs[0]);
            }
            try { await message.channel.send(`✅ Moved to **${voiceChannel.name}** and resumed playback!`); } catch (_) {}
            return;
        }

        // ffmpeg pipeline rebuild
        const queueConstruct = {
            textchannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: null,
            songs: songs,
            volume: vol,
            playing: true,
            loop: loop,
            skipped: false,
            currentResource: null,
            ffmpegProcess: null,
            filters: filters,
            restarting: false,
            disconnectTimer: null,
            useLavalink: false
        };
        global.queue.set("queue", queueConstruct);

        const connection = await utils.joinVChannel(voiceChannel, client);
        queueConstruct.connection = connection;

        if (queueConstruct.songs[0]) {
            await utils.play(queueConstruct.songs[0]);
        }
        try { await message.channel.send(`✅ Moved to **${voiceChannel.name}** and resumed playback!`); } catch (_) {}
    } catch (e) {
        console.error("Error moving to voice channel:", e);
        try { await message.channel.send(`❌ Failed to move to the new voice channel: ${e && e.message ? e.message : e}`); } catch (_) {}
    }
}

module.exports.names = {
    list: ["join", "j"]
};
