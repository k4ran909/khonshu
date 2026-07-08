const strings = require("../strings.json");
const utils = require("../utils");

const TRACKS_PER_PAGE = 10;

/** 
 * @description Show the guild's song queue with pagination
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args page number (optional)
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = global.queue.get("queue");

    if(!serverQueue || !serverQueue.songs || serverQueue.songs.length === 0){
        return message.channel.send(strings.noSongsQueued);
    }

    // Currently playing song
    const nowPlaying = serverQueue.songs[0];
    const npMinutes = `${Math.floor(nowPlaying.duration / 60)}`.padStart(2, "0");
    const npSeconds = `${nowPlaying.duration % 60}`.padStart(2, "0");
    const loopIcon = serverQueue.loop ? " 🔄" : "";
    const filterInfo = (serverQueue.filters && serverQueue.filters.length > 0) 
        ? ` 🎛️ ${serverQueue.filters.join(", ")}` 
        : "";

    let response = `🎵 **Now Playing:** \`\`(${npMinutes}:${npSeconds}) ${nowPlaying.title}${loopIcon}${filterInfo}\`\`\n`;

    // Queued songs (everything after index 0)
    const queuedSongs = serverQueue.songs.slice(1);

    if (queuedSongs.length === 0) {
        response += "\n📋 Queue is empty. Add more songs with `$play`.";
        return message.channel.send(response);
    }

    // Calculate pagination
    const totalPages = Math.ceil(queuedSongs.length / TRACKS_PER_PAGE);
    let page = 1;
    if (args[0]) {
        const parsed = parseInt(args[0]);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= totalPages) {
            page = parsed;
        }
    }

    const startIdx = (page - 1) * TRACKS_PER_PAGE;
    const endIdx = Math.min(startIdx + TRACKS_PER_PAGE, queuedSongs.length);
    const pageSongs = queuedSongs.slice(startIdx, endIdx);

    response += `\n${strings.musicsQueued}\n`;

    for (let i = 0; i < pageSongs.length; i++) {
        const song = pageSongs[i];
        const globalIdx = startIdx + i + 1;  // 1-indexed position in queue
        const minutes = `${Math.floor(song.duration / 60)}`.padStart(2, "0");
        const seconds = `${song.duration % 60}`.padStart(2, "0");
        response += `\`\`${globalIdx}. (${minutes}:${seconds}) ${song.title} — ${song.requestedby}\`\`\n`;
    }

    // Footer with pagination info
    response += `\n📄 Page **${page}/${totalPages}** • **${queuedSongs.length}** tracks queued`;
    if (totalPages > 1) {
        response += ` • Use \`$queue <page>\` to navigate`;
    }

    utils.log(`Showed music queue (page ${page}/${totalPages})`);
    return message.channel.send(response);
}


module.exports.names = {
    list: ["queue", "q"]
};