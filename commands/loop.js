const strings = require("../strings.json");
const utils = require("../utils");

/**
 * @description Toggle looping of the currently playing song.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args unused
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = global.queue.get("queue");

    if (!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0) {
        try { await message.channel.send(strings.cantLoop); } catch (_) {}
        return;
    }

    const currentTitle = (serverQueue.songs[0] && serverQueue.songs[0].title) || "current track";

    if (serverQueue.loop === false) {
        serverQueue.loop = true;
        utils.log(`Started looping : ${currentTitle}`);
        try { await message.channel.send(strings.loopOn.replace("SONG_TITLE", currentTitle)); } catch (_) {}
    } else {
        serverQueue.loop = false;
        utils.log(`Stopped looping : ${currentTitle}`);
        try { await message.channel.send(strings.loopOff.replace("SONG_TITLE", currentTitle)); } catch (_) {}
    }
};

module.exports.names = {
    list: ["loop", "l"]
};
