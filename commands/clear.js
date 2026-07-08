const utils = require("../utils");

/**
 * @description Clear every queued track except the one currently playing.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args unused
 */
module.exports.run = async (client, message, args) => {
    const location = message.guild ? message.guild.name : "DM";
    utils.log(`Clearing queue, command from ${location}`);

    const serverQueue = global.queue.get("queue");

    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) {
        try { await message.channel.send("❌ Nothing to clear — the queue is empty."); } catch (_) {}
        return;
    }

    const removed = Math.max(0, serverQueue.songs.length - 1);
    serverQueue.songs = [serverQueue.songs[0]];

    if (removed === 0) {
        try { await message.channel.send("🧹 Queue was already clear — kept the current track."); } catch (_) {}
    } else {
        try { await message.channel.send(`🧹 Cleared **${removed}** track${removed === 1 ? "" : "s"} from the queue.`); } catch (_) {}
    }
};

module.exports.names = {
    list: ["clear"]
};
