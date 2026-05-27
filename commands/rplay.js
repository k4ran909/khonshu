const strings = require("../strings.json");
const utils = require("../utils");
const YouTube = require("youtube-sr").default;

// YouTube URL pattern
const YT_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;

/** 
 * @description Remote play — play music in any guild/voice channel by providing IDs directly
 * Usage: rplay <guild_id> <voice_channel_id> <song URL or search query>
 * @param {Discord.Client} client the client that runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args guild_id, voice_channel_id, and song query
 */
module.exports.run = async (client, message, args) => {

    if (args.length < 3) {
        return message.channel.send(
            "❌ **Usage:** `rplay <guild_id> <voice_channel_id> <song URL or search>`\n" +
            "**Example:** `rplay 123456789 987654321 https://youtu.be/dQw4w9WgXcQ`"
        );
    }

    const guildId = args[0];
    const channelId = args[1];
    const query = args.slice(2).join(" ");

    // Resolve the guild
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return message.channel.send(`❌ Bot is not in a server with ID: \`${guildId}\``);
    }

    // Resolve the voice channel
    const voiceChannel = guild.channels.cache.get(channelId);
    if (!voiceChannel) {
        return message.channel.send(`❌ No channel found with ID: \`${channelId}\` in **${guild.name}**`);
    }
    if (!voiceChannel.isVoice || (voiceChannel.type !== "GUILD_VOICE" && voiceChannel.type !== "GUILD_STAGE_VOICE" && voiceChannel.type !== 2 && voiceChannel.type !== 13)) {
        return message.channel.send(`❌ \`${channelId}\` is not a voice channel. It's a ${voiceChannel.type} channel.`);
    }

    utils.log(`[RPLAY] Remote play in ${guild.name} > ${voiceChannel.name} | Query: "${query}"`);

    // ───────────────────────────────────────
    // Resolve the song (YouTube URL or search)
    // ───────────────────────────────────────
    let song;

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

        // Fallback metadata if still unknown
        if (title === "Unknown Track") {
            utils.log(`[RPLAY] YouTube library failed. Trying fallback metadata...`);
            try {
                const meta = await utils.fetchMetadata(url);
                if (meta && meta.title) {
                    title = meta.title;
                    duration = meta.duration;
                    utils.log(`[RPLAY] Fallback metadata success! Title: "${title}"`);
                }
            } catch (metaError) {
                utils.log(`[RPLAY] Fallback metadata failed: ${metaError.message}`);
            }
        }

        song = { title, duration, url, requestedby: message.author.username };

    } else {
        // Search query
        utils.log(`[RPLAY] Searching: "${query}"`);
        try {
            const results = await YouTube.search(query, { limit: 1 });
            if (!results || results.length === 0) {
                // Try fallback search
                try {
                    const fallbackResult = await utils.fetchSearch(query);
                    if (fallbackResult && fallbackResult.url) {
                        song = {
                            title: fallbackResult.title,
                            duration: fallbackResult.duration,
                            url: fallbackResult.url,
                            requestedby: message.author.username
                        };
                    }
                } catch (searchErr) {}

                if (!song) {
                    return message.channel.send("❌ No results found for your query.");
                }
            } else {
                song = {
                    title: results[0].title,
                    duration: Math.floor(results[0].duration / 1000),
                    url: `https://www.youtube.com/watch?v=${results[0].id}`,
                    requestedby: message.author.username
                };
            }
        } catch (e) {
            utils.log(`[RPLAY] Standard search failed. Trying fallback...`);
            try {
                const fallbackResult = await utils.fetchSearch(query);
                if (fallbackResult && fallbackResult.url) {
                    song = {
                        title: fallbackResult.title,
                        duration: fallbackResult.duration,
                        url: fallbackResult.url,
                        requestedby: message.author.username
                    };
                }
            } catch (searchErr) {}

            if (!song) {
                return message.channel.send("❌ Error searching for the track.");
            }
        }
    }

    // ───────────────────────────────────────
    // Add to queue and play
    // ───────────────────────────────────────
    utils.log(`[RPLAY] Got: "${song.title}" — joining ${voiceChannel.name}...`);

    let serverQueue = queue.get("queue");

    // Stop any active video stream if switching to audio
    if (serverQueue && serverQueue.isVideo) {
        utils.log("[RPLAY] Stopping active video stream to switch to audio.");
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
        // No active queue — create one and start playing
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
            filters: [],
            restarting: false,
            disconnectTimer: null
        };

        queue.set("queue", queueConstruct);
        queueConstruct.songs.push(song);

        try {
            const connection = await utils.joinVChannel(voiceChannel, client);
            queueConstruct.connection = connection;
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${guild.name}** > **${voiceChannel.name}**`);
                song._discordMsg = sentMsg;
            } catch (e) {}
            await utils.play(queueConstruct.songs[0]);
        } catch (e) {
            console.error("[RPLAY] Error joining/playing:", e);
            queue.delete("queue");
            return message.channel.send(`❌ Failed to join **${voiceChannel.name}**: ${e.message}`);
        }
    } else {
        // Queue exists — add to it
        if (serverQueue.disconnectTimer) {
            clearTimeout(serverQueue.disconnectTimer);
            serverQueue.disconnectTimer = null;
        }

        serverQueue.songs.push(song);

        // If queue was empty (e.g. after a failed track), start playback
        if (serverQueue.songs.length === 1) {
            utils.log(`[RPLAY] Queue was idle, starting playback: ${song.title}`);
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${guild.name}** > **${voiceChannel.name}**`);
                song._discordMsg = sentMsg;
            } catch (e) {}
            await utils.play(song);
        } else {
            utils.log(`[RPLAY] Added to queue: ${song.title}`);
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' has been added to the queue`);
                song._discordMsg = sentMsg;
            } catch (e) {}
        }
    }
};

module.exports.names = {
    list: ["rplay", "rp", "remoteplay"]
};
