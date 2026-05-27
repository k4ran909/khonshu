const strings = require("../strings.json");
const utils = require("../utils");

/** 
 * @description Stops the music and leaves the channel
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args useless here  
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = queue.get("queue");
    if(!serverQueue){return message.channel.send(strings.nothingPlaying);};

    utils.log("Stopped playing music");

    // Clear auto-disconnect timer
    if (serverQueue.disconnectTimer) {
        clearTimeout(serverQueue.disconnectTimer);
        serverQueue.disconnectTimer = null;
    }

    // Delete queue FIRST so standard Idle handler or streams won't trigger clean up
    queue.delete("queue");

    if (serverQueue.isVideo) {
        utils.log("[STOP] Terminating video screenshare stream and leaving voice.");
        // Video Stream Clean up
        if (serverQueue.streamPlay && serverQueue.streamPlay.command) {
            try {
                serverQueue.streamPlay.command.kill();
            } catch (e) {}
        }
        if (serverQueue.streamer) {
            try {
                serverQueue.streamer.leaveVoice();
            } catch (e) {}
        }
        return message.channel.send("📺 Video streaming stopped cleanly.");
    }

    // Kill audio streaming processes FIRST (before stopping the player)
    // This prevents ffmpeg from writing to a closed pipe
    if (serverQueue.ffmpegProcess) {
        try {
            // Use SIGINT for graceful shutdown, then force-kill after a timeout
            serverQueue.ffmpegProcess.kill('SIGINT');
            if (serverQueue.ffmpegProcess.ytdlpProcess) {
                serverQueue.ffmpegProcess.ytdlpProcess.kill('SIGINT');
            }
        } catch (e) {}
    }

    // Small delay to let ffmpeg flush and shut down cleanly
    await new Promise(r => setTimeout(r, 100));

    // Now stop the audio player
    if (serverQueue.player) {
        try {
            serverQueue.player.stop(true);
        } catch (e) {}
    }

    // Destroy voice connection (leaves the channel)
    if (serverQueue.connection) {
        try {
            serverQueue.connection.destroy();
        } catch (e) {}
    }

    // Leave Lavalink voice too
    if (serverQueue.guildId) {
        try {
            const lavalink = require("../lavalink");
            const player = lavalink.getPlayer(serverQueue.guildId);
            if (player) {
                await player.stopTrack();
            }
            lavalink.leaveChannel(serverQueue.guildId);
        } catch (e) {}
    }

    return message.channel.send(strings.musicStopped);

};

module.exports.names = {
    list: ["stop", "st"]
};