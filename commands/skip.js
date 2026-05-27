const strings = require("../strings.json");
const utils = require("../utils");

/** 
 * @description Skip the current song
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args useless here  
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = queue.get("queue");
    if(!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0){return message.channel.send(strings.nothingPlaying);};

    utils.log(`Skipped music : ${serverQueue.songs[0].title}`);

    serverQueue.skipped = true;

    // If using Lavalink, stop the Lavalink player
    if (serverQueue.useLavalink && serverQueue.guildId) {
        try {
            const lavalink = require("../lavalink");
            const player = lavalink.getPlayer(serverQueue.guildId);
            if (player) {
                await player.stopTrack();
                return message.channel.send(strings.musicSkipped);
            }
        } catch (e) {
            console.error("Lavalink skip error:", e);
        }
    }

    // Kill current audio processes gracefully FIRST
    if (serverQueue.ffmpegProcess) {
        try {
            serverQueue.ffmpegProcess.kill('SIGINT');
            if (serverQueue.ffmpegProcess.ytdlpProcess) {
                serverQueue.ffmpegProcess.ytdlpProcess.kill('SIGINT');
            }
        } catch (e) {}
    }

    // Small delay to let ffmpeg flush and shut down cleanly
    await new Promise(r => setTimeout(r, 100));

    // Stop the player - this triggers the Idle event which plays the next song
    if (serverQueue.player) {
        try {
            serverQueue.player.stop();
        } catch (e) {
            console.error("Error skipping track:", e);
        }
    }

    return message.channel.send(strings.musicSkipped);

};

module.exports.names = {
    list: ["skip", "s"]
};