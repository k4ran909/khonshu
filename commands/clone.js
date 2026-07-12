const utils = require("../utils");
const fs = require("fs");
const path = require("path");

const BACKUP_FILE = path.join(__dirname, "..", "profile-backup.json");

// Discord-pfp-api base. It reads a target's name/avatar/banner/accent server-side
// using a bot token, so it works for ANY user with no mutual-guild requirement —
// unlike GET /users/:id (bot-only; 401s for user tokens) or /users/:id/profile
// (requires a mutual guild / friendship). Overridable via PFP_API_BASE.
const PFP_API_BASE = (process.env.PFP_API_BASE || "http://discord.tsunstudio.pw").replace(/\/+$/, "");

function cdnBanner(id, hash) {
    if (!hash) return null;
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/banners/${id}/${hash}.${ext}?size=1024`;
}

// Turn Discord's write-side errors into short, readable strings. The big one is
// the captcha: PATCH /users/@me gets challenged when Discord thinks the account
// is automated (very common from datacenter IPs), and the library's default
// solver just throws CAPTCHA_SOLVER_NOT_IMPLEMENTED.
function cleanErr(e) {
    const msg = e && e.message ? e.message : String(e);
    if (/CAPTCHA_SOLVER_NOT_IMPLEMENTED|captcha/i.test(msg)) return "blocked by Discord captcha";
    return msg.split("\n")[0].slice(0, 120);
}

// Bump a Discord CDN URL to 1024px (the API returns size=512).
function upsizeCdn(url) {
    if (!url) return url;
    return url.replace(/([?&])size=\d+/, "$1size=1024");
}

// Primary reader: the Discord-pfp-api. Returns name/avatar/banner/accent for any
// user. Does NOT provide bio — that's filled in separately by the profile endpoint
// when a relationship exists. Throws on network/HTTP failure so the caller can
// surface a clear error.
async function fetchFromPfpApi(id) {
    const res = await fetch(`${PFP_API_BASE}/api/user/${id}/raw`, {
        headers: { "Accept": "application/json" },
        redirect: "follow"
    });
    if (!res.ok) {
        const err = new Error(`pfp-api HTTP ${res.status}`);
        err.httpStatus = res.status;
        throw err;
    }
    const data = await res.json();
    if (!data || data.error) {
        const err = new Error(data && data.error ? data.error : "pfp-api returned no data");
        err.httpStatus = 404;
        throw err;
    }
    return {
        id: data.id || id,
        username: data.username || "unknown",
        globalName: data.display_name || data.username || null,
        avatarURL: upsizeCdn(data.avatarUrl) || null,
        bannerURL: upsizeCdn(data.bannerUrl) || cdnBanner(data.id || id, data.banner),
        accentColor: typeof data.accent_color === "number" ? data.accent_color : null,
        bio: null,
        profileReadable: true
    };
}

// Best-effort bio reader. Bio ("About Me") only lives on GET /users/:id/profile,
// which requires a mutual guild / friendship / pending request. Returns the bio
// string, or null if unavailable — never throws.
async function fetchBioBestEffort(client, id) {
    try {
        const profile = await client.api.users(id).profile.get({
            query: { with_mutual_guilds: true, with_mutual_friends: false }
        });
        const up = (profile && profile.user_profile) || {};
        const u = (profile && profile.user) || {};
        if (typeof up.bio === "string") return up.bio;
        if (typeof u.bio === "string") return u.bio;
        return null;
    } catch (e) {
        utils.log(`[CLONE] Bio not readable for ${id} (no mutual guild/friend?): ${e && e.message ? e.message : e}`);
        return null;
    }
}

async function fetchTargetProfile(client, id) {
    // Name/avatar/banner/accent from the pfp-API (works for any user)...
    const target = await fetchFromPfpApi(id);
    // ...then try to enrich with bio from the relationship-gated profile endpoint.
    target.bio = await fetchBioBestEffort(client, id);
    target.bioReadable = target.bio !== null;
    return target;
}

// Snapshot the bot's own current profile so it can be restored later.
async function backupOwnProfile(client) {
    const me = client.user;
    const backup = {
        savedAt: new Date().toISOString(),
        globalName: me.globalName || null,
        bio: null,
        accentColor: typeof me.accentColor === "number" ? me.accentColor : null,
        avatarDataURL: null,
        bannerDataURL: null
    };

    // Read our own bio via profile fetch (self always readable).
    try {
        const profile = await me.getProfile();
        if (profile && profile.user_profile && typeof profile.user_profile.bio === "string") {
            backup.bio = profile.user_profile.bio;
        }
    } catch (_) {}

    // Snapshot images as data URLs — CDN hashes change once we overwrite them.
    try {
        const a = me.avatarURL ? me.avatarURL({ format: "png", size: 1024, dynamic: true }) : null;
        if (a) backup.avatarDataURL = await utils.fetchImageAsDataURL(a);
    } catch (_) {}
    try {
        const b = me.banner ? me.bannerURL({ format: "png", size: 1024, dynamic: true }) : null;
        if (b) backup.bannerDataURL = await utils.fetchImageAsDataURL(b);
    } catch (_) {}

    try {
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2) + "\n", "utf8");
        return true;
    } catch (e) {
        utils.log(`[CLONE] Failed to write profile-backup.json: ${e && e.message ? e.message : e}`);
        return false;
    }
}

/**
 * @description Clone a Discord user's profile (display name, avatar, banner,
 *   accent color, bio/about) onto this account. Owner-only.
 *   Usage: $clone <userID | @mention>   •   $clone restore
 * @param {Discord.Client} client
 * @param {Discord.Message} message
 * @param {Array<String>} args
 */
module.exports.run = async (client, message, args) => {

    if (message.author.id !== global.config.owner) {
        try { await message.channel.send("❌ Only the bot owner can clone profiles."); } catch (_) {}
        return;
    }

    const first = (args[0] || "").toLowerCase();

    // ─── Restore path ───
    if (first === "restore" || first === "revert" || first === "reset") {
        if (!fs.existsSync(BACKUP_FILE)) {
            try { await message.channel.send("❌ No profile backup found. Nothing to restore."); } catch (_) {}
            return;
        }
        let backup;
        try { backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8")); }
        catch (e) {
            try { await message.channel.send(`❌ Backup file is corrupted: ${e && e.message ? e.message : e}`); } catch (_) {}
            return;
        }

        const restored = [];
        const failed = [];
        try { await client.user.setGlobalName(backup.globalName || ""); restored.push("name"); } catch (e) { failed.push(`name (${e.message})`); }
        try { await client.user.setAboutMe(backup.bio || ""); restored.push("bio"); } catch (e) { failed.push(`bio (${e.message})`); }
        try { await client.user.setAccentColor(backup.accentColor ?? null); restored.push("accent"); } catch (e) { failed.push(`accent (${e.message})`); }
        if (backup.avatarDataURL) { try { await client.user.setAvatar(backup.avatarDataURL); restored.push("avatar"); } catch (e) { failed.push(`avatar (${e.message})`); } }
        if (backup.bannerDataURL) { try { await client.user.setBanner(backup.bannerDataURL); restored.push("banner"); } catch (e) { failed.push(`banner (${e.message})`); } }

        utils.log(`[CLONE] Owner restored profile from backup (${restored.join(", ")})`);
        let msg = `✅ Restored your profile: ${restored.length ? restored.join(", ") : "nothing"}.`;
        if (failed.length) msg += `\n⚠️ Failed: ${failed.join("; ")}`;
        try { await message.channel.send(msg); } catch (_) {}
        return;
    }

    // ─── Clone path ───
    const id = (args[0] || "").replace(/[<@!>]/g, "").trim();
    if (!utils.isSnowflake(id)) {
        try { await message.channel.send("❌ Usage: `$clone <userID | @mention>`  •  `$clone restore` to revert."); } catch (_) {}
        return;
    }

    let target;
    try {
        target = await fetchTargetProfile(client, id);
    } catch (e) {
        // The pfp-API reads via a bot token, so it works for any user. A failure
        // here is a bad ID (404) or the API being unreachable — not a relationship
        // problem. Translate into actionable guidance.
        const code = (e && (e.httpStatus || e.status)) || 0;
        const raw = e && e.message ? e.message : String(e);
        let hint;
        if (code === 404 || /Unknown User|no data/i.test(raw)) {
            hint = "❌ No user exists with that ID (or the profile API couldn't find them). Double-check the ID.";
        } else if (code === 429) {
            hint = "❌ The profile API is rate-limited right now. Wait a minute and try again.";
        } else {
            hint = `❌ Couldn't reach the profile API: ${raw}\n_Set \`PFP_API_BASE\` to a working instance if the default host is down._`;
        }
        utils.log(`[CLONE] Profile fetch failed for ${id} (code ${code}): ${raw}`);
        try { await message.channel.send(hint); } catch (_) {}
        return;
    }

    let status;
    try { status = await message.channel.send(`⏳ Cloning **${target.globalName || target.username}**… backing up your profile first.`); } catch (_) {}

    // Back up our own profile before overwriting (only if no backup exists yet,
    // so repeated clones don't clobber the original with a cloned snapshot).
    if (!fs.existsSync(BACKUP_FILE)) {
        await backupOwnProfile(client);
    }

    const applied = [];
    const skipped = [];
    const failed = [];

    // Name (display name) — always available.
    const name = target.globalName || target.username;
    try { await client.user.setGlobalName(name); applied.push(`name → ${name}`); }
    catch (e) { failed.push(`name (${cleanErr(e)})`); }

    // Avatar.
    if (target.avatarURL) {
        try { await client.user.setAvatar(target.avatarURL); applied.push("avatar"); }
        catch (e) { failed.push(`avatar (${cleanErr(e)})`); }
    } else skipped.push("avatar (none)");

    // Bio / About Me. Only readable via the relationship-gated profile endpoint.
    if (typeof target.bio === "string" && target.bio.length) {
        try { await client.user.setAboutMe(target.bio); applied.push("bio"); }
        catch (e) { failed.push(`bio (${cleanErr(e)})`); }
    } else if (target.bioReadable) {
        skipped.push("bio (empty)");
    } else {
        skipped.push("bio (not readable — need a mutual server or friendship with the target)");
    }

    // Banner. Setting a banner requires Nitro on THIS account; treat that as a
    // clean skip rather than a scary failure.
    if (target.bannerURL) {
        try { await client.user.setBanner(target.bannerURL); applied.push("banner"); }
        catch (e) {
            if (/nitro/i.test(e && e.message ? e.message : "")) skipped.push("banner (needs Nitro on your account)");
            else failed.push(`banner (${cleanErr(e)})`);
        }
    } else skipped.push("banner (none)");

    // Accent color.
    if (typeof target.accentColor === "number") {
        try { await client.user.setAccentColor(target.accentColor); applied.push("accent color"); }
        catch (e) { failed.push(`accent (${cleanErr(e)})`); }
    } else skipped.push("accent color (none)");

    utils.log(`[CLONE] Owner cloned ${id} — applied: ${applied.join(", ")}`);

    const lines = [`✅ Cloned **${name}** (\`${id}\`)`];
    if (applied.length) lines.push(`• Applied: ${applied.join(", ")}`);
    if (skipped.length) lines.push(`• Skipped: ${skipped.join(", ")}`);
    if (failed.length) lines.push(`• ⚠️ Failed: ${failed.join("; ")}`);

    // If writes were captcha-blocked, explain it — it's a Discord anti-automation
    // challenge (common on datacenter IPs), not a bug in the command.
    if (failed.some(f => /captcha/i.test(f))) {
        lines.push("ℹ️ _Discord blocked the profile edits with a captcha (common when the bot runs on a VPS/datacenter IP). Running from a residential IP usually avoids it._");
    }

    lines.push(`_Run \`${global.config.prefix || "$"}clone restore\` to revert to your original profile._`);

    const content = lines.join("\n");
    try {
        if (status && status.edit) await status.edit({ content, allowedMentions: { parse: [] } });
        else await message.channel.send({ content, allowedMentions: { parse: [] } });
    } catch (_) {}
};

module.exports.names = {
    list: ["clone"]
};
