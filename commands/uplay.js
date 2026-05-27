const strings = require("../strings.json");
const utils = require("../utils");
const YouTube = require("youtube-sr").default;

// YouTube URL pattern
const YT_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/;

/** 
 * @description User play — mention a user, jump to their VC, and play a song
 * Usage: uplay @user <song URL or search query>
 * @param {Discord.Client} client the client that runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args user mention and song query
 */
module.exports.run = async (client, message, args) => {

    if (args.length < 2) {
        return message.channel.send(
            "❌ **Usage:** `uplay @user <song URL or search>`\n" +
            "**Example:** `uplay @Someone https://youtu.be/dQw4w9WgXcQ`"
        );
    }

    // Extract user ID from mention (<@123456> or <@!123456>) or raw ID
    const userInput = args[0];
    const userIdMatch = userInput.match(/^<@!?(\d+)>$/) || userInput.match(/^(\d{17,20})$/);
    if (!userIdMatch) {
        return message.channel.send("❌ Please mention a valid user or provide their ID.\n**Example:** `uplay @Someone <song>`");
    }
    const targetUserId = userIdMatch[1];

    const query = args.slice(1).join(" ");

    // Find the user's voice channel across all guilds
    let voiceChannel = null;
    let targetGuild = null;
    let foundInGuild = null; // Track if user exists in any mutual server

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
        } catch (e) {}
    }

    // If not found in cache, try fetching from all guilds
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
            } catch (e) {}
        }
    }

    if (!foundInGuild) {
        return message.channel.send(`❌ <@${targetUserId}> is not in any mutual server.`);
    }

    if (!voiceChannel) {
        return message.channel.send(`❌ <@${targetUserId}> is not in any voice channel right now.`);
    }

    utils.log(`[UPLAY] Target user <${targetUserId}> found in ${targetGuild.name} > ${voiceChannel.name}`);

    // ───────────────────────────────────────
    // Resolve the song (YouTube URL or search)
    // ───────────────────────────────────────
    let song;

    if (YT_URL_REGEX.test(query)) {
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
            utils.log(`[UPLAY] YouTube library failed. Trying fallback metadata...`);
            try {
                const meta = await utils.fetchMetadata(url);
                if (meta && meta.title) {
                    title = meta.title;
                    duration = meta.duration;
                    utils.log(`[UPLAY] Fallback metadata success! Title: "${title}"`);
                }
            } catch (metaError) {
                utils.log(`[UPLAY] Fallback metadata failed: ${metaError.message}`);
            }
        }

        song = { title, duration, url, requestedby: message.author.username };

    } else {
        utils.log(`[UPLAY] Searching: "${query}"`);
        try {
            const results = await YouTube.search(query, { limit: 1 });
            if (!results || results.length === 0) {
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
            utils.log(`[UPLAY] Standard search failed. Trying fallback...`);
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
    utils.log(`[UPLAY] Got: "${song.title}" — joining ${voiceChannel.name} in ${targetGuild.name}...`);

    let serverQueue = queue.get("queue");

    if (serverQueue && serverQueue.isVideo) {
        utils.log("[UPLAY] Stopping active video stream to switch to audio.");
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
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${targetGuild.name}** > **${voiceChannel.name}**`);
                song._discordMsg = sentMsg;
            } catch (e) {}
            await utils.play(queueConstruct.songs[0]);
        } catch (e) {
            console.error("[UPLAY] Error joining/playing:", e);
            queue.delete("queue");
            return message.channel.send(`❌ Failed to join **${voiceChannel.name}**: ${e.message}`);
        }
    } else {
        if (serverQueue.disconnectTimer) {
            clearTimeout(serverQueue.disconnectTimer);
            serverQueue.disconnectTimer = null;
        }

        serverQueue.songs.push(song);

        // If queue was empty (e.g. after a failed track), start playback
        if (serverQueue.songs.length === 1) {
            utils.log(`[UPLAY] Queue was idle, starting playback: ${song.title}`);
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' started playing in **${targetGuild.name}** > **${voiceChannel.name}**`);
                song._discordMsg = sentMsg;
            } catch (e) {}
            await utils.play(song);
        } else {
            utils.log(`[UPLAY] Added to queue: ${song.title}`);
            try {
                const sentMsg = await message.channel.send(`✅ '**${song.title}**' has been added to the queue`);
                song._discordMsg = sentMsg;
            } catch (e) {}
        }
    }
};

module.exports.names = {
    list: ["uplay", "up", "userplay"]
};
