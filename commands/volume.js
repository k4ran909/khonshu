const strings = require("../strings.json");
const utils = require("../utils");

// Volume boundaries (matches the range documented in strings.volumeToHigh + $help).
const MIN_VOLUME = 0.1;
const MAX_VOLUME = 10;
// Lavalink's setGlobalVolume takes 0-1000 (0 = mute, 100 = 100%).
const LAVALINK_MAX = 1000;

/**
 * @description Change playback volume on both the ffmpeg pipeline and the Lavalink pipeline.
 *              Also supports `earrape`: a temporary 100× spike, gated by a reaction confirm.
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args volume level (0.1 - 10 or "earrape")
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = global.queue.get("queue");

    if (args.length > 1) {
        try { await message.channel.send(strings.toMuchArgsVolume); } catch (_) {}
        return;
    }
    if (args.length === 0) {
        try { await message.channel.send(strings.noVolume); } catch (_) {}
        return;
    }

    // Earrape branch (must come before numeric parsing — "earrape" isn't a number)
    if (typeof args[0] === "string" && args[0].toLowerCase() === "earrape") {
        return runEarrape(client, message, serverQueue);
    }

    // Numeric parsing — strict: reject NaN, ±Infinity, negatives, zero, and trailing garbage.
    const raw = args[0];
    if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(raw)) {
        try { await message.channel.send(strings.noNumber); } catch (_) {}
        return;
    }
    const floatVolume = parseFloat(raw);
    if (!Number.isFinite(floatVolume)) {
        try { await message.channel.send(strings.noNumber); } catch (_) {}
        return;
    }
    if (floatVolume > MAX_VOLUME) {
        try { await message.channel.send(strings.volumeToHigh); } catch (_) {}
        return;
    }
    if (floatVolume < MIN_VOLUME) {
        try { await message.channel.send(`❌ Volume must be at least ${MIN_VOLUME} (use \`$stop\` to mute).`); } catch (_) {}
        return;
    }

    if (serverQueue) {
        // Queue exists — update live volume on whichever pipeline is active.
        serverQueue.volume = floatVolume;
        if (serverQueue.currentResource && serverQueue.currentResource.volume) {
            serverQueue.currentResource.volume.setVolume(floatVolume);
        }
        if (serverQueue.useLavalink && serverQueue.guildId) {
            try {
                const lavalink = require("../lavalink");
                const player = lavalink.getPlayer(serverQueue.guildId);
                if (player) {
                    const lavalinkVol = Math.min(LAVALINK_MAX, Math.max(0, Math.round(floatVolume * 100)));
                    await player.setGlobalVolume(lavalinkVol);
                }
            } catch (e) {
                console.error("Lavalink volume change error:", e);
            }
        }
    } else {
        // No queue yet — stash on the queueConstruct default so the next $play picks it up.
        // NOTE: consumers must fall back with `?? 1`, not `|| 1`, so 0 stays 0. See rplay/uplay/play.
        global.pendingVolume = floatVolume;
    }

    try { await message.channel.send(strings.volumeChanged.replace("VOLUME", floatVolume)); } catch (_) {}
};

/**
 * `$volume earrape` — 100× volume for 7 seconds, gated by ✅ reaction from the invoker only.
 */
async function runEarrape(client, message, serverQueue) {
    if (!serverQueue) {
        try { await message.channel.send("❌ You need to have a song playing for earrape."); } catch (_) {}
        return;
    }

    let warning;
    try {
        warning = await message.channel.send(strings.earrapeWarning);
        await warning.react('✅');
    } catch (e) {
        utils.log(`[EARRAPE] Could not send/react warning: ${e && e.message ? e.message : e}`);
        return;
    }

    const filter = (reaction, user) => reaction.emoji.name === "✅" && user.id === message.author.id;

    // discord.js v13 collector signature: single options object with `filter` inside.
    // The old (filter, opts) positional form is ignored under v13 and would accept any user's reaction.
    const collector = warning.createReactionCollector({ filter, max: 1, time: 8000 });

    collector.on('collect', () => {
        // Snapshot as `const` in this closure so overlapping earrapes don't race
        // the way the old module-scoped `oldVolume` leak used to.
        const oldVolume = serverQueue.volume;
        serverQueue.volume = 100;
        if (serverQueue.currentResource && serverQueue.currentResource.volume) {
            try { serverQueue.currentResource.volume.setVolume(100); } catch (_) {}
        }
        if (serverQueue.useLavalink && serverQueue.guildId) {
            try {
                const lavalink = require("../lavalink");
                const player = lavalink.getPlayer(serverQueue.guildId);
                if (player) {
                    // 100 * 100 = 10000 clamps to Lavalink's 1000 ceiling.
                    player.setGlobalVolume(LAVALINK_MAX);
                }
            } catch (_) {}
        }
        message.channel.send(strings.startEarrape).catch(() => {});

        setTimeout(() => {
            serverQueue.volume = oldVolume;
            if (serverQueue.currentResource && serverQueue.currentResource.volume) {
                try { serverQueue.currentResource.volume.setVolume(oldVolume); } catch (_) {}
            }
            if (serverQueue.useLavalink && serverQueue.guildId) {
                try {
                    const lavalink = require("../lavalink");
                    const player = lavalink.getPlayer(serverQueue.guildId);
                    if (player) {
                        const lavalinkVol = Math.min(LAVALINK_MAX, Math.max(0, Math.round(oldVolume * 100)));
                        player.setGlobalVolume(lavalinkVol);
                    }
                } catch (_) {}
            }
            message.channel.send(strings.endEarrape.replace("VOLUME", oldVolume)).catch(() => {});
        }, 7000);
    });

    collector.on('end', (collected) => {
        // `collected.size` reflects only reactions that passed the filter (v13 semantics).
        if (!collected || collected.size === 0) {
            message.channel.send(strings.earrapeFail).catch(() => {});
        }
    });
}

module.exports.names = {
    list: ["volume", "v"]
};
