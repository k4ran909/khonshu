const strings = require("../strings.json");
const utils = require("../utils");

/** 
 * @description Make the bot join/move to the user's current voice channel
 *              If the VC is full, sends a DM error. If already playing, continues playback in the new VC.
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args useless here  
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
        if (!voiceChannel) return message.channel.send("❌ You need to be in a voice channel first.");
    } else {
        voiceChannel = message.member.voice.channel;
        if(!voiceChannel){return message.channel.send(strings.notInVocal)};
    }

    // ─── Check if the VC is full ───
    if (voiceChannel.userLimit > 0 && voiceChannel.members.size >= voiceChannel.userLimit) {
        utils.log(`[JOIN] VC "${voiceChannel.name}" is full (${voiceChannel.members.size}/${voiceChannel.userLimit})`);
        // Send error via DM to the owner
        try {
            const owner = await client.users.fetch(global.config.owner);
            if (owner) {
                await owner.send(`❌ **${voiceChannel.name}** is full (${voiceChannel.members.size}/${voiceChannel.userLimit}). Make some space and try again.`);
            }
        } catch (e) {
            // Fallback to the command channel if DM fails
            try { await message.channel.send(`❌ **${voiceChannel.name}** is full (${voiceChannel.members.size}/${voiceChannel.userLimit}). Make some space and try again.`); } catch (e2) {}
        }
        return;
    }

    const serverQueue = queue.get("queue");

    utils.log(`[JOIN] Joining channel: ${voiceChannel.name} (${voiceChannel.id})`);

    if (!serverQueue) {
        // ─── No music playing — just join the voice channel ───
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
                queue.set("queue", queueConstruct);
                return message.channel.send(strings.joinMsg);
            } else {
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
                    disconnectTimer: null
                };

                queue.set("queue", queueConstruct);
                return message.channel.send(strings.joinMsg);
            }
        } catch (e) {
            console.error("Error joining voice channel:", e);
            return message.channel.send("❌ Failed to join voice channel.");
        }

    } else if (serverQueue.voiceChannel && serverQueue.voiceChannel.id === voiceChannel.id) {
        // ─── Already in the same VC ───
        return message.channel.send("✅ Already in your voice channel!");

    } else if (serverQueue.voiceChannel && serverQueue.voiceChannel.guild.id !== voiceChannel.guild.id) {
        // ─── Different guild — destroy old connection, rebuild in new guild ───
        utils.log(`[JOIN] Moving across guilds: ${serverQueue.voiceChannel.guild.name} → ${voiceChannel.guild.name}`);

        // 1. SAVE everything FIRST before touching the old player
        const songs = [...serverQueue.songs];
        const filters = serverQueue.filters ? [...serverQueue.filters] : [];
        const vol = serverQueue.volume;
        const loop = serverQueue.loop;

        // 2. Clear auto-disconnect timer
        if (serverQueue.disconnectTimer) {
            clearTimeout(serverQueue.disconnectTimer);
        }

        // 3. DELETE queue FIRST so old player's Idle handler exits early
        queue.delete("queue");

        // 4. NOW safely stop the old player/ffmpeg/connection
        if (serverQueue.ffmpegProcess) {
            try { serverQueue.ffmpegProcess.kill(); } catch (e) {}
        }
        if (serverQueue.player) {
            try { serverQueue.player.stop(true); } catch (e) {}
        }
        if (serverQueue.connection) {
            try { serverQueue.connection.destroy(); } catch (e) {}
        }

        // 5. Build the new queue
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
            disconnectTimer: null
        };

        queue.set("queue", queueConstruct);

        try {
            const connection = await utils.joinVChannel(voiceChannel, client);
            queueConstruct.connection = connection;

            // Resume playing the current song
            if (queueConstruct.songs[0]) {
                await utils.play(queueConstruct.songs[0]);
            }

            return message.channel.send(`✅ Moved to **${voiceChannel.name}** and resumed playback!`);
        } catch (e) {
            console.error("Error joining new voice channel:", e);
            return message.channel.send("❌ Failed to move to the new voice channel.");
        }

    } else {
        // ─── Same guild, different VC — move and continue playing ───
        utils.log(`[JOIN] Moving within guild: ${serverQueue.voiceChannel.name} → ${voiceChannel.name}`);

        // 1. SAVE everything FIRST before touching the old player
        const songs = [...serverQueue.songs];
        const filters = serverQueue.filters ? [...serverQueue.filters] : [];
        const vol = serverQueue.volume;
        const loop = serverQueue.loop;

        // 2. Clear auto-disconnect timer
        if (serverQueue.disconnectTimer) {
            clearTimeout(serverQueue.disconnectTimer);
        }

        // 3. DELETE queue FIRST so old player's Idle handler exits early
        queue.delete("queue");

        // 4. NOW safely stop the old player/ffmpeg/connection
        if (serverQueue.ffmpegProcess) {
            try { serverQueue.ffmpegProcess.kill(); } catch (e) {}
        }
        if (serverQueue.player) {
            try { serverQueue.player.stop(true); } catch (e) {}
        }
        if (serverQueue.connection) {
            try { serverQueue.connection.destroy(); } catch (e) {}
        }

        // 5. Build the new queue
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
            disconnectTimer: null
        };

        queue.set("queue", queueConstruct);

        try {
            const connection = await utils.joinVChannel(voiceChannel, client);
            queueConstruct.connection = connection;

            // Resume playing the current song in the new VC
            if (queueConstruct.songs[0]) {
                await utils.play(queueConstruct.songs[0]);
            }

            return message.channel.send(`✅ Moved to **${voiceChannel.name}** and resumed playback!`);
        } catch (e) {
            console.error("Error moving to voice channel:", e);
            return message.channel.send("❌ Failed to move to the new voice channel.");
        }
    }
};

module.exports.names = {
    list: ["join", "j"]
};