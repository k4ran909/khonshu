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

    client.user.setActivity("gud music", {type: "LISTENING"});

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