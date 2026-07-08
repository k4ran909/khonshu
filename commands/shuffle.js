const strings = require("../strings.json");
const utils = require("../utils");

/** 
 * @description Shuffle the current queue (keeps the currently playing song at position 0)
 * @param {Discord.Client} client the client that runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args unused
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = global.queue.get("queue");

    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length <= 2) {
        return message.channel.send("❌ Not enough songs in the queue to shuffle (need at least 2 queued tracks).");
    }

    // Keep the currently playing song (index 0), shuffle the rest
    const currentSong = serverQueue.songs[0];
    const rest = serverQueue.songs.slice(1);

    // Fisher-Yates shuffle
    for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
    }

    serverQueue.songs = [currentSong, ...rest];

    utils.log(`[SHUFFLE] Queue shuffled (${rest.length} tracks randomized)`);

    try {
        await message.channel.send(`🔀 Queue shuffled! **${rest.length}** tracks randomized.`);
    } catch (e) {}
};

module.exports.names = {
    list: ["shuffle", "sh", "random"]
};
