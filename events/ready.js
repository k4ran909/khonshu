const utils = require('../utils');
const lavalink = require('../lavalink');

module.exports = async (client) => {

    // Initialize Shoukaku/Lavalink now that the client is fully logged in and has a valid user ID
    try {
        utils.log("[LAVALINK] Initializing Shoukaku/Lavalink node connection...");
        lavalink.init(client);
    } catch (e) {
        utils.log(`[LAVALINK] Failed to initialize Shoukaku: ${e.message}`);
    }

    // Restore the last presence set via $status / $activity, falling back to a
    // sensible default. This runs on every boot so the presence survives restarts.
    try {
        const saved = utils.loadPresence();
        const status = (saved && saved.status) || "online";
        const activity = saved && saved.activity;

        client.user.setStatus(status);
        if (activity && activity.name) {
            client.user.setActivity(activity.name, { type: activity.type || "PLAYING" });
        } else if (!saved) {
            // No persisted presence yet — keep the original default activity.
            client.user.setActivity("gud music", { type: "LISTENING" });
        }
    } catch (e) {
        utils.log(`[PRESENCE] Failed to restore presence on startup: ${e && e.message ? e.message : e}`);
    }

    utils.log(`Logged in as ${client.user.username} !`);

    // Detect owner's current voice channel on startup
    if (global.config.owner) {
        for (const [, guild] of client.guilds.cache) {
            try {
                const member = await guild.members.fetch(global.config.owner);
                if (member && member.voice && member.voice.channel) {
                    global.ownerVoiceChannel = member.voice.channel;
                    utils.log(`[VOICE] Owner found in: ${member.voice.channel.name} (${guild.name})`);
                    break;
                }
            } catch (e) {
                // Owner not in this guild, skip
            }
        }
    }
};