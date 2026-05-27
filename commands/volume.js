const strings = require("../strings.json");
const utils = require("../utils");

/** 
 * @description Change playback volume using inline volume on AudioResource
 * @param {Discord.Client} client the client thats runs the commands
 * @param {Discord.Message} message the command's message
 * @param {Array<String>} args volume level (1-10 or "earrape")
 */
module.exports.run = async (client, message, args) => {

    const serverQueue = queue.get("queue");

    if(args.length > 1) return message.channel.send(strings.toMuchArgsVolume);
    if(args.length === 0) return message.channel.send(strings.noVolume);

    floatVolume = parseFloat(args);

    if(!Number.isInteger(parseInt(args)) && utils.isFloat(floatVolume) && args != "earrape") return message.channel.send(strings.noNumber);

    if (args[0] === "earrape"){

        if (!serverQueue) return message.channel.send("❌ You need to have a song playing for earrape.");

        message.channel.send(strings.earrapeWarning)
        .then(async function (warning) {

            await warning.react('✅');

            const filter = (reaction, user) => {
                return reaction.emoji.name == "✅" && user.id == message.author.id;
            };
             
            const collector = warning.createReactionCollector(filter, { max: 1, time: 8000 });
       
            collector.on('collect', () => {
                oldVolume = serverQueue.volume;
                serverQueue.volume = 100;
                if (serverQueue.currentResource && serverQueue.currentResource.volume) {
                    serverQueue.currentResource.volume.setVolume(100);
                }
                if (serverQueue.useLavalink && serverQueue.guildId) {
                    try {
                        const lavalink = require("../lavalink");
                        const player = lavalink.getPlayer(serverQueue.guildId);
                        if (player) {
                            player.setGlobalVolume(10000); // 100 * 100 = 10000
                        }
                    } catch (e) {}
                }
                message.channel.send(strings.startEarrape);
                setTimeout(function(){
                    message.channel.send(strings.endEarrape.replace("VOLUME", oldVolume));
                    serverQueue.volume = oldVolume;
                    if (serverQueue.currentResource && serverQueue.currentResource.volume) {
                        serverQueue.currentResource.volume.setVolume(oldVolume);
                    }
                    if (serverQueue.useLavalink && serverQueue.guildId) {
                        try {
                            const lavalink = require("../lavalink");
                            const player = lavalink.getPlayer(serverQueue.guildId);
                            if (player) {
                                player.setGlobalVolume(Math.round(oldVolume * 100));
                            }
                        } catch (e) {}
                    }
                }, 7000);
            });

            collector.on(`end`, () => {
                if(collector.total === 0) return message.channel.send(strings.earrapeFail);
            });

        });
    } else {

        if(args[0] > 10) return message.channel.send(strings.volumeToHigh);

        if (serverQueue) {
            // Queue exists — update live volume
            serverQueue.volume = floatVolume;
            if (serverQueue.currentResource && serverQueue.currentResource.volume) {
                serverQueue.currentResource.volume.setVolume(floatVolume);
            }
            if (serverQueue.useLavalink && serverQueue.guildId) {
                try {
                    const lavalink = require("../lavalink");
                    const player = lavalink.getPlayer(serverQueue.guildId);
                    if (player) {
                        const lavalinkVol = Math.round(floatVolume * 100);
                        player.setGlobalVolume(lavalinkVol);
                    }
                } catch (e) {
                    console.error("Lavalink volume change error:", e);
                }
            }
        } else {
            // No queue yet — store volume globally so next song uses it
            global.pendingVolume = floatVolume;
        }

        message.channel.send(strings.volumeChanged.replace("VOLUME", args[0]));
    };
};

module.exports.names = {
    list: ["volume", "v"]
};