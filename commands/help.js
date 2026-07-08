const utils = require("../utils");

/**
 * @description Show the full command menu with every command, alias, subcommand, and flag
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args unused
 */
module.exports.run = async (client, message, args) => {

    const helpMenu =
`🌙 **Khonshu — Command Menu** 🌙

**🎵 Music**
\`$play <query/URL>\` \`(p)\` — Play audio from YouTube or Spotify
\`$vplay <query/URL>\` \`(vp)\` — Stream video via Go Live or Virtual Camera
\`$stop\` \`(st)\` — Stop music and leave VC
\`$skip\` \`(s)\` — Skip to the next track
\`$join\` \`(j)\` — Move bot to your current VC
\`$loop\` \`(l)\` — Toggle loop on current track

**📜 Queue**
\`$queue [page]\` \`(q)\` — View the queue (10 per page)
\`$shuffle\` \`(sh, random)\` — Shuffle queued tracks randomly
\`$clear\` — Clear the entire queue (keeps current track)

**🎛️ Filters** \`$filter\` \`(f, fx, effect)\`
\`$filter\` — Show currently active filters
\`$filter list\` — Show active + available filters
\`$filter bassboost\` — Heavy low-end boost (toggle)
\`$filter nightcore\` — 1.25× speed + higher pitch (toggle)
\`$filter vaporwave\` — 0.8× speed + lower pitch (toggle)
\`$filter 8d\` — Audio pans left ↔ right (toggle)
\`$filter clear\` \`(off, reset)\` — Remove all filters
_(Filters can be stacked. Runs on ffmpeg pipeline; Lavalink pipeline supports equalizer/timescale/rotation only.)_

**🔊 Volume** \`$volume\` \`(v)\`
\`$volume <0.1 - 10>\` — Set playback volume (1 = 100%)
\`$volume earrape\` — ⚠ 100× volume for 7s (requires ✅ confirmation)

**🎥 Video Streaming** \`$vplay\` \`(vp)\`
\`$vplay <query/URL>\` — Default: Go Live screenshare
\`$vplay -s <query/URL>\` — Screenshare (aliases: \`--screenshare\`, \`--go-live\`, \`--live\`)
\`$vplay -c <query/URL>\` — Virtual Camera (aliases: \`--camera\`, \`--cam\`)
\`$vplay obs <query/URL>\` — Route through OBS Virtual Camera device
\`$vplay camera <query/URL>\` — Same as \`obs\` (shortcut: \`cam\`)

**🎯 Targeted Playback**
\`$rplay <guildId> <channelId> <query/URL>\` \`(rp, remoteplay)\` — Play in any guild+VC by ID
\`$uplay @user <query/URL>\` \`(up, userplay)\` — Jump to a user's current VC and play
_(Both accept raw user/guild IDs. If a session is already running in a different location, it is torn down and rebuilt at the target.)_

**🌐 Server Management** \`$server\` \`(joinserver, invite)\`
\`$server list\` — Show all servers the bot is in (top 25 by member count)
\`$server info <invite>\` — Preview a server without joining
\`$server leave <guildId>\` — Leave a server

**🟢 Spotify**
Paste any Spotify link directly through \`$play\`:
\`$play https://open.spotify.com/track/...\`
\`$play https://open.spotify.com/playlist/...\`
\`$play https://open.spotify.com/album/...\`

**❓ Help** \`$help\` \`(h, menu, commands)\` — This menu

**💡 Tips**
• Commands work via **@mention** in servers and directly in **DMs**
• Bot auto-disconnects after **5 min** of inactivity
• Filters can be **stacked** together
• Only the configured owner can run commands`;

    try {
        // Discord caps a single message at 2000 chars; this menu is longer, so
        // split it into chunks on blank lines (section boundaries) and send each.
        const chunks = [];
        let current = "";
        for (const block of helpMenu.split("\n\n")) {
            // +2 for the "\n\n" we re-add between blocks.
            if (current.length + block.length + 2 > 1900) {
                if (current) chunks.push(current);
                current = block;
            } else {
                current = current ? `${current}\n\n${block}` : block;
            }
        }
        if (current) chunks.push(current);

        for (const chunk of chunks) {
            await message.channel.send(chunk);
        }
        utils.log(`Showed help menu (${chunks.length} message${chunks.length === 1 ? "" : "s"})`);
    } catch (e) {
        utils.log(`Help send failed: ${e && e.message ? e.message : e}`);
    }
};

module.exports.names = {
    list: ["help", "h", "menu", "commands"]
};
