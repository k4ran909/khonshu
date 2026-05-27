const utils = require("../utils");

/** 
 * @description Show the full command menu with all available commands
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args unused
 */
module.exports.run = async (client, message, args) => {

    const helpMenu = 
`🌙 **Khonshu — Command Menu** 🌙

**🎵 Music**
\`$play <query/URL>\` — Play audio from YouTube or Spotify
\`$vplay <query/URL>\` — Stream video screenshare from YouTube (vp)
\`$stop\` — Stop music and leave VC
\`$skip\` — Skip to the next track
\`$join\` — Move bot to your current VC
\`$queue [page]\` — View the queue (paginated)
\`$loop\` — Toggle loop on current track
\`$clear\` — Clear the entire queue

**🔀 Queue**
\`$shuffle\` — Shuffle queued tracks randomly

**🎛️ Filters**
\`$filter bassboost\` — Heavy low-end boost
\`$filter nightcore\` — 1.25x speed + higher pitch
\`$filter vaporwave\` — 0.8x speed + lower pitch
\`$filter 8d\` — Audio pans left ↔ right
\`$filter clear\` — Remove all filters
\`$filter\` — Show active filters

**🔊 Volume**
\`$volume <0.1 - 10>\` — Adjust playback volume

**🟢 Spotify**
Paste any Spotify link directly:
\`$play https://open.spotify.com/track/...\`
\`$play https://open.spotify.com/playlist/...\`
\`$play https://open.spotify.com/album/...\`

**💡 Tips**
• Commands work via **@mention** in servers and **DMs**
• Bot auto-disconnects after **5 min** of inactivity
• Filters can be **stacked** together`;

    try {
        await message.channel.send(helpMenu);
    } catch (e) {}

    utils.log("Showed help menu");
};

module.exports.names = {
    list: ["help", "h", "menu", "commands"]
};
