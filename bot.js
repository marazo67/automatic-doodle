// ======================== TARAGON BOT - TELEGRAM + WHATSAPP ========================
// Deploy on Render, runs both Telegram (pairing) and WhatsApp (all commands)
// Install: npm install express @whiskeysockets/baileys pino node-telegram-bot-api axios yt-search
// ===================================================================================

const express = require('express');
const http = require('http');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const yts = require('yt-search');
const TelegramBot = require('node-telegram-bot-api');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ========================= YOUR CONFIG =========================
const TELEGRAM_TOKEN = '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E'; // from @BotFather
const PORT = process.env.PORT || 3000;
// ==============================================================

// ── DIRECTORIES & FILES ────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, 'auth_main');
const TEMP_DIR = path.join(__dirname, 'temp');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const WARNINGS_FILE = path.join(__dirname, 'warnings.json');
const ANTIDELETE_FILE = path.join(__dirname, 'antidelete.json');

[path.join(__dirname, 'public'), TEMP_DIR, AUTH_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── PERSISTENT SETTINGS (same as original) ─────────────────────
let settings = {};
let warnings = {};
let antidelete = {};
if (fs.existsSync(SETTINGS_FILE)) settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
if (fs.existsSync(WARNINGS_FILE)) warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
if (fs.existsSync(ANTIDELETE_FILE)) antidelete = JSON.parse(fs.readFileSync(ANTIDELETE_FILE));

const defaultSettings = {
    mode: 'public',
    chatbotGlobal: false,
    autoreact: false,
    autostatus: false,
    autostatusView: false,
    autostatusRead: false,
    statusLike: false,
    groupStatusShare: false,
    autotyping: false,
    autoread: false,
    anticall: false,
    pmblocker: false,
    pmblockerMsg: '🔒 Private messages are blocked. Contact owner.',
    mention: false,
    mentionMsg: '',
    antidelete: false,
    chatbotGroups: {},
    antilink: {},
    antibadword: {},
    antitag: {},
    welcome: {},
    goodbye: {},
    groupStatusGroups: {},
    autoForwardStatus: false,
    statusCaption: '🇻🇦 *TARAGON SQUAD TRS* | Status Update',
    birthdayWish: false,
    antiFlood: {},
    floodCount: {},
    schedule: [],
    funMode: true,
    afk: false,
    afkMsg: '🤖 Bot is AFK. Will reply soon.',
    polls: {},
};

Object.entries(defaultSettings).forEach(([k, v]) => {
    if (settings[k] === undefined) settings[k] = v;
});

function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
function saveWarnings() { fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2)); }
function saveAntidelete() { fs.writeFileSync(ANTIDELETE_FILE, JSON.stringify(antidelete, null, 2)); }

// ── GLOBALS ─────────────────────────────────────────────────────
let whatsAppSocket = null;
let botNumber = null;
let botStartTime = Date.now();
const chatMemory = { messages: new Map(), userInfo: new Map() };
const BAD_WORDS = ['badword1', 'stupid', 'idiot', 'fuck', 'shit', 'fokof', 'tsek', 'nggA', 'fusek', 'asshole', 'dumass', 'kill you'];
const api = axios.create({ timeout: 30000 });

// ── HELPERS (from original) ─────────────────────────────────────
const downloadBuffer = async (url) => (await api.get(url, { responseType: 'arraybuffer' })).data;

const getMediaBuffer = async (msg, type) => {
    const stream = await downloadContentFromMessage(msg, type);
    let buffer = Buffer.alloc(0);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
};

async function translate(text, targetLang) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await api.get(url);
        return res.data[0][0][0];
    } catch { return text; }
}

function extractUserInfo(message) {
    const info = {};
    if (message.toLowerCase().includes('my name is')) info.name = message.split('my name is')[1].trim().split(' ')[0];
    if (message.toLowerCase().includes('years old')) info.age = message.match(/\d+/)?.[0];
    if (/i (?:live in|am from)/i.test(message)) info.location = message.split(/(?:i live in|i am from)/i)[1].trim().split(/[.,!?]/)[0];
    return info;
}

// ── AI (same as original) ─────────────────────────────────────
const ALL_AI_APIS = [
    { name: 'ZellAPI', url: (q) => `https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`, extract: (d) => d?.result },
    { name: 'Vapis Gemini', url: (q) => `https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`, extract: (d) => d?.message },
    { name: 'Siputzx', url: (q) => `https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`, extract: (d) => d?.data },
    { name: 'Ryzen', url: (q) => `https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`, extract: (d) => d?.answer },
    { name: 'GiftedPro', url: (q) => `https://api.giftedtech.my.id/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(q)}`, extract: (d) => d?.answer },
    { name: 'ZellBackup', url: (q) => `https://zellapi.autos/ai/chatbot?text=${encodeURIComponent('Reply to: ' + q)}`, extract: (d) => d?.result },
];

async function getAIResponse(userMessage, senderId, contextMessages = []) {
    const prompt = `You're Scottie Kiidrsa, a real person. Reply in 1-2 lines max. Use Hinglish naturally. Be savage if abused, sweet if treated well. NEVER say you're AI. Context: ${contextMessages.slice(-5).join(' | ')}. Message: ${userMessage}`;
    const promises = ALL_AI_APIS.map(async (a) => {
        try {
            const res = await axios.get(a.url(prompt), { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const answer = a.extract(res.data);
            if (answer && typeof answer === 'string' && answer.length > 2)
                return answer.trim()
                    .replace(/^(AI|Bot|Assistant|Answer|Response|Reply):?\s*/i, '')
                    .replace(/Remember:.*$|IMPORTANT:.*$|CORE RULES:.*$/g, '')
                    .trim();
        } catch { }
        return null;
    });
    const results = await Promise.allSettled(promises);
    for (const r of results) if (r.status === 'fulfilled' && r.value) return r.value;
    const fallbacks = ["Haan bhai! 😊", "Kya scene hai? 😎", "Hmm soch raha hu... 🤔", "Kya baat hai! 🔥", "Bhai tu legend hai! 👑"];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ── DOWNLOAD HELPERS (same as original) ───────────────────────
const AXIOS_DEFAULTS = { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };
const tryRequest = async (fn, attempts = 3) => {
    for (let i = 1; i <= attempts; i++) {
        try { return await fn(); }
        catch (err) { if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i)); else throw err; }
    }
};

async function downloadSong(urlOrQuery) {
    const isUrl = /youtube\.com|youtu\.be/i.test(urlOrQuery);
    let video;
    if (isUrl) video = { url: urlOrQuery, title: 'YouTube Video' };
    else {
        const search = await yts(urlOrQuery);
        if (!search?.videos?.length) throw new Error('No results');
        video = search.videos[0];
    }
    const apis = [
        { url: `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(video.url)}&format=mp3`, extract: (d) => d?.data?.downloadURL },
        { url: `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.data?.data?.download_url },
        { url: `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.data?.dl },
    ];
    for (const a of apis) {
        try {
            const res = await tryRequest(() => axios.get(a.url, AXIOS_DEFAULTS));
            const url = a.extract(res);
            if (url) {
                const buffer = await downloadBuffer(url);
                return { buffer, title: res.data?.title || video.title, mime: 'audio/mpeg', ext: 'mp3' };
            }
        } catch { }
    }
    try {
        const out = path.join(TEMP_DIR, `audio_${Date.now()}.mp3`);
        await execAsync(`yt-dlp -x --audio-format mp3 -o "${out}" "${video.url}"`, { timeout: 120000 });
        if (fs.existsSync(out)) { const b = fs.readFileSync(out); fs.unlinkSync(out); return { buffer: b, title: video.title, mime: 'audio/mpeg', ext: 'mp3' }; }
    } catch { }
    throw new Error('All download sources failed.');
}

async function ytDlpVideo(url) {
    const out = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
    await execAsync(`yt-dlp -f "best[ext=mp4]" -o "${out}" "${url}"`, { timeout: 300000 });
    if (fs.existsSync(out)) { const b = fs.readFileSync(out); fs.unlinkSync(out); return { download: b, title: 'Video' }; }
    throw new Error('Failed');
}

async function downloadTikTok(url) {
    const res = await tryRequest(() =>
        axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, { timeout: 15000, headers: { accept: '*/*' } })
    );
    if (res?.data?.data) {
        const d = res.data.data;
        const u = d.urls?.[0] || d.video_url || d.url || d.download_url;
        if (u) return { videoUrl: u, title: d.metadata?.title || 'TikTok' };
    }
    throw new Error('Failed');
}

async function spotifyCommand(input, jid, quoted, sendMsg) {
    if (!input) return sendMsg(jid, { text: 'Usage: !spotify <song>' }, { quoted });
    try {
        const { data } = await axios.get(`https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(input)}`, { timeout: 20000 });
        if (data?.status && data?.result?.audio) {
            const r = data.result;
            const cap = `🎵 ${r.title}\n👤 ${r.artist || ''}`;
            if (r.thumbnails) await sendMsg(jid, { image: { url: r.thumbnails }, caption: cap }, { quoted });
            await sendMsg(jid, { audio: { url: r.audio }, mimetype: 'audio/mpeg', fileName: `${r.title || 'track'}.mp3` }, { quoted });
        } else throw new Error('No audio');
    } catch { await sendMsg(jid, { text: '❌ Spotify failed.' }, { quoted }); }
}

// ── STYLED MESSAGE HELPER ──────────────────────────────────────
function createSendStyledMessage(sock, botName) {
    return async (jid, content, options = {}) => {
        content.contextInfo = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363@newsletter',
                newsletterName: `${botName} v3.1.0`,
                serverMessageId: 1
            },
            ...(content.contextInfo || {})
        };
        return sock.sendMessage(jid, content, options);
    };
}

// ── SCHEDULER & FLOOD TRACKING ──────────────────────────────────
function startScheduler(sock, sendMsg) {
    setInterval(async () => {
        const now = Date.now();
        for (const job of settings.schedule) {
            if (!job.active) continue;
            if (now >= job.nextRun) {
                try { await sendMsg(job.jid, { text: job.text }); } catch { }
                if (job.repeat) job.nextRun = now + job.intervalMs;
                else job.active = false;
            }
        }
        saveSettings();
    }, 30_000);
}

const floodTracker = new Map();
function checkFlood(jid, sender) {
    if (!settings.antiFlood?.[jid]) return false;
    if (!floodTracker.has(jid)) floodTracker.set(jid, new Map());
    const groupMap = floodTracker.get(jid);
    if (!groupMap.has(sender)) groupMap.set(sender, []);
    const times = groupMap.get(sender);
    const now = Date.now();
    const window = 5000;
    const limit = settings.antiFlood[jid] || 5;
    const recent = times.filter(t => now - t < window);
    recent.push(now);
    groupMap.set(sender, recent);
    return recent.length >= limit;
}

// ── FUN REPLIES ─────────────────────────────────────────────────
const FUN_TRIGGERS = {
    'good morning': ['🌅 Good morning! Have a blessed day! ☀️', '🌞 Rise and shine! Morning bhai! 🇻🇦'],
    'good night': ['🌙 Sweet dreams! 💤', '😴 Good night! Rest well king 👑'],
    'gm': ['🌅 GM! Taragon squad is live! 🇻🇦'],
    'gn': ['🌙 GN! Stay blessed! ✨'],
    'lol': ['😂😂😂', 'Haha bhai ded 💀'],
    'bruh': ['💀 Same bhai same', '😭 Bhai bruh moment'],
    'gg': ['🎮 GG WP!', '🏆 EZ Clap!'],
    'fr': ['💯 FR FR no cap', '🔥 Facts bhai'],
    'ngl': ['😅 Honest hour!', '👀 No cap detected'],
};

function getFunReply(text) {
    const lower = text.toLowerCase().trim();
    for (const [trigger, replies] of Object.entries(FUN_TRIGGERS)) {
        if (lower === trigger || lower.startsWith(trigger + ' ')) {
            return replies[Math.floor(Math.random() * replies.length)];
        }
    }
    return null;
}

// ======================== WHATSAPP BOT SETUP ========================
function setupBot(sock, phoneNumber) {
    const ownerNumber = `${phoneNumber}@s.whatsapp.net`;
    const botName = '𝐓𝐀𝐑𝐀𝐆𝐎𝐍 𝐒𝐐𝐔𝐀𝐃 𝐓𝐑𝐒🇻🇦';
    const sendStyledMessage = createSendStyledMessage(sock, botName);
    const startTime = Date.now();

    startScheduler(sock, sendStyledMessage);

    // ─── Status events (original) ──────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.remoteJid === 'status@broadcast') {
                const participant = msg.key.participant || msg.key.remoteJid;
                if (settings.autostatusView) await sock.readMessages([msg.key]).catch(() => { });
                if (settings.statusLike && participant) {
                    await sock.sendMessage('status@broadcast', { react: { text: '❤️', key: msg.key } }, { statusJidList: [participant] }).catch(() => { });
                }
                if (settings.autostatus && participant) {
                    const emojis = ['❤️', '🔥', '😍', '👑', '💯', '🇻🇦', '✨', '😎'];
                    await sock.sendMessage('status@broadcast', { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key } }, { statusJidList: [participant] }).catch(() => { });
                }
                if (settings.groupStatusShare) {
                    const groupJids = Object.keys(settings.groupStatusGroups).filter(k => settings.groupStatusGroups[k]);
                    for (const gid of groupJids) {
                        try {
                            const cap = `${settings.statusCaption}\n\n👁 Shared from contacts`;
                            if (msg.message?.imageMessage) {
                                const buf = await getMediaBuffer(msg.message.imageMessage, 'image');
                                await sendStyledMessage(gid, { image: buf, caption: cap });
                            } else if (msg.message?.videoMessage) {
                                const buf = await getMediaBuffer(msg.message.videoMessage, 'video');
                                await sendStyledMessage(gid, { video: buf, caption: cap });
                            } else if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
                                const t = msg.message.conversation || msg.message.extendedTextMessage.text;
                                await sendStyledMessage(gid, { text: `${cap}\n\n${t}` });
                            }
                        } catch { }
                    }
                }
                return;
            }
        }
    });

    // ─── Main message handler ─────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message) return;
        const jid = msg.key.remoteJid;
        if (jid === 'status@broadcast') return;
        const isGroup = jid?.endsWith('@g.us');
        const sender = isGroup ? msg.key.participant : jid;
        const isOwner = sender === ownerNumber;
        const isFromMe = msg.key.fromMe;
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const isCommand = text.startsWith('!');

        if (settings.autoread && !isFromMe) await sock.readMessages([msg.key]).catch(() => { });
        if (settings.autotyping && !isFromMe) {
            sock.sendPresenceUpdate('composing', jid).catch(() => { });
            setTimeout(() => sock.sendPresenceUpdate('paused', jid).catch(() => { }), 2000);
        }
        if (settings.autoreact && !isCommand && !isFromMe) {
            const emojis = ['❤️', '👍', '😂', '😮', '😢', '👏', '🇻🇦', '🔥'];
            await sock.sendMessage(jid, { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: msg.key } }).catch(() => { });
        }
        if (settings.afk && !isFromMe && !isGroup) {
            await sendStyledMessage(jid, { text: settings.afkMsg }, { quoted: msg });
        }
        if (msg.message?.call && settings.anticall && !isOwner) {
            await sendStyledMessage(jid, { text: '📞 Bot rejects calls.' });
            return;
        }
        if (!isGroup && !isOwner && !isFromMe && settings.pmblocker) {
            await sendStyledMessage(jid, { text: settings.pmblockerMsg });
            return;
        }
        if (isGroup && !isFromMe) {
            if (checkFlood(jid, sender)) {
                await sock.sendMessage(jid, { delete: msg.key }).catch(() => { });
                await sendStyledMessage(jid, { text: `⚡ @${sender.split('@')[0]} slow down! Flood detected.`, mentions: [sender] });
                return;
            }
            if (settings.antilink?.[jid] && /https?:\/\//i.test(text)) {
                await sock.sendMessage(jid, { delete: msg.key });
                await sendStyledMessage(jid, { text: '🔗 Links not allowed in this group.' });
                return;
            }
            if (settings.antibadword?.[jid] && BAD_WORDS.some(w => text.toLowerCase().includes(w))) {
                await sock.sendMessage(jid, { delete: msg.key });
                await sendStyledMessage(jid, { text: '🚫 Bad words are prohibited here.' });
                return;
            }
        }

        const chatbotOn = settings.chatbotGlobal || (isGroup && settings.chatbotGroups?.[jid]);
        if (!isCommand && !isFromMe && chatbotOn && text) {
            const botJids = [sock.user.id, `${phoneNumber}@s.whatsapp.net`, `${phoneNumber}@lid`];
            let shouldReply = false;
            if (msg.message?.extendedTextMessage) {
                const mentioned = msg.message.extendedTextMessage.contextInfo?.mentionedJid || [];
                if (mentioned.some(j => botJids.some(b => j?.includes(b?.split('@')[0])))) shouldReply = true;
            } else if (text.includes(`@${phoneNumber}`)) shouldReply = true;
            else if (!isGroup) shouldReply = true;

            if (shouldReply) {
                await sock.sendPresenceUpdate('composing', jid).catch(() => { });
                const uid = sender;
                if (!chatMemory.messages.has(uid)) chatMemory.messages.set(uid, []);
                const msgs = chatMemory.messages.get(uid);
                msgs.push(text);
                if (msgs.length > 20) msgs.shift();
                const info = extractUserInfo(text);
                if (Object.keys(info).length) chatMemory.userInfo.set(uid, { ...(chatMemory.userInfo.get(uid) || {}), ...info });
                const reply = await getAIResponse(text, uid, msgs);
                await sendStyledMessage(jid, { text: reply }, { quoted: msg });
                return;
            }
        }

        if (settings.funMode && !isCommand && !isFromMe && text) {
            const fun = getFunReply(text);
            if (fun) { await sendStyledMessage(jid, { text: fun }, { quoted: msg }); return; }
        }

        if (!isCommand) return;
        if (settings.mode === 'private' && !isOwner) return;

        const args = text.slice(1).trim().split(/ +/);
        const command = args[0]?.toLowerCase();
        const input = args.slice(1).join(' ');
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedKey = msg.message?.extendedTextMessage?.contextInfo;
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

        const getGroupMeta = async () => { if (!isGroup) throw new Error('Not a group'); return sock.groupMetadata(jid); };
        const isAdmin = async () => {
            if (!isGroup) return false;
            if (isOwner) return true;
            try { const m = await getGroupMeta(); const u = m.participants.find(p => p.id === sender); return u?.admin === 'admin' || u?.admin === 'superadmin'; } catch { return false; }
        };

        try {
            switch (command) {
                // ── Basics ────────────────────────────────────────────────────
                case 'ping': { const s = Date.now(); await sendStyledMessage(jid, { text: `🏓 Pong! ${Date.now() - s}ms` }); break; }
                case 'alive': { const u = Date.now() - startTime; const h = Math.floor(u / 3600000), m = Math.floor((u % 3600000) / 60000), s = Math.floor((u % 60000) / 1000); await sendStyledMessage(jid, { text: `✅ *${botName}*\n📱 WhatsApp: +${phoneNumber}\n⏰ Uptime: ${h}h ${m}m ${s}s\n🌐 Mode: ${settings.mode}` }); break; }
                case 'owner': await sendStyledMessage(jid, { text: `👑 Owner: wa.me/${phoneNumber}` }); break;
                case 'session': if (!isOwner) return; await sendStyledMessage(jid, { text: `🔑 Connected WhatsApp: +${phoneNumber}` }); break;
                case 'menu': case 'help': {
                    const menu = `╭━━━❰ *${botName}* ❯━━━╮\n┃ ⚡ Mode: ${settings.mode}  |  WhatsApp: +${phoneNumber}\n╰━━━━━━━━━━━━━━━━━━━━╯\n\n🌐 *GENERAL*\n  !ping  !alive  !menu  !owner\n\n🤖 *AI*\n  !gpt <q>  !gemini <q>  !imagine <prompt>\n\n📥 *DOWNLOADERS*\n  !play <song>  !ytmp3 <url>  !ytmp4 <url>\n  !tiktok <url>  !spotify <song>\n  !instagram <url>  !facebook <url>\n\n👮 *MODERATION* (admins)\n  !ban  !promote  !demote  !mute [min]  !unmute\n  !tagall  !del  !warn @user  !warnings @user\n  !resetwarn @user  !antilink on|off\n  !antibadword on|off  !antiflood on|off|<n>\n  !poll <q> | opt1 | opt2  !endpoll\n\n📊 *STATUS TOOLS* (owner)\n  !autostatus on|off  !statuslike on|off\n  !autostatusview on|off  !statusshare on|off\n  !addstatusgroup  !removestatusgroup\n\n🔒 *OWNER SETTINGS*\n  !mode public|private\n  !autoreact on|off  !autotyping on|off\n  !autoread on|off   !anticall on|off\n  !pmblocker on|off  !antidelete on|off\n  !afk on|off  !afkmsg <message>\n  !funmode on|off  !chatbot on|off\n  !welcome on|off  !goodbye on|off\n  !schedule <jid> <minutes> <repeat?> <text>\n  !cleartmp  !settings`;
                    await sendStyledMessage(jid, { text: menu }); break;
                }

                // ── AI Commands ───────────────────────────────────────────────
                case 'gpt': case 'gemini': { if (!input) return sendStyledMessage(jid, { text: `Usage: !${command} <question>` }); const reply = await getAIResponse(input, sender); await sendStyledMessage(jid, { text: `🤖 ${reply}` }); break; }
                case 'imagine': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !imagine <prompt>' }); await sendStyledMessage(jid, { text: '🎨 Generating image…' }); try { const { data } = await api.get(`https://api.siputzx.my.id/api/ai/stablediffusion?prompt=${encodeURIComponent(input)}`); const u = typeof data === 'string' ? data : data?.url || data?.image; if (u) { const b = await downloadBuffer(u); await sendStyledMessage(jid, { image: b, caption: input }); } else throw new Error('No image URL'); } catch { await sendStyledMessage(jid, { text: '❌ Image generation failed.' }); } break; }

                // ── Downloaders ───────────────────────────────────────────────
                case 'play': case 'ytmp3': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !play <song/url>' }); await sendStyledMessage(jid, { text: '⏳ Downloading audio…' }); try { const { buffer, title, mime, ext } = await downloadSong(input); await sendStyledMessage(jid, { audio: buffer, mimetype: mime, fileName: `${title}.${ext}`, ptt: false }, { quoted: msg }); } catch (e) { await sendStyledMessage(jid, { text: `❌ ${e.message}` }); } break; }
                case 'ytmp4': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !ytmp4 <url>' }); await sendStyledMessage(jid, { text: '⏳ Downloading video…' }); try { let v; try { const r = await tryRequest(() => axios.get(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(input)}`, AXIOS_DEFAULTS)); if (r?.data?.data?.download_url) v = { url: r.data.data.download_url, title: r.data.data.title }; } catch { } if (!v) try { const r = await tryRequest(() => axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(input)}`, AXIOS_DEFAULTS)); if (r?.data?.result?.mp4) v = { url: r.data.result.mp4, title: r.data.result.title }; } catch { } if (!v) { const { download, title } = await ytDlpVideo(input); await sendStyledMessage(jid, { video: download, caption: title }); return; } const b = await downloadBuffer(v.url); await sendStyledMessage(jid, { video: b, caption: v.title }); } catch (e) { await sendStyledMessage(jid, { text: `❌ ${e.message}` }); } break; }
                case 'tiktok': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !tiktok <url>' }); await sendStyledMessage(jid, { text: '⏳ Downloading TikTok…' }); try { const { videoUrl, title } = await downloadTikTok(input); const b = await downloadBuffer(videoUrl); await sendStyledMessage(jid, { video: b, caption: title }); } catch (e) { await sendStyledMessage(jid, { text: `❌ ${e.message}` }); } break; }
                case 'spotify': await spotifyCommand(input, jid, msg, sendStyledMessage); break;
                case 'instagram': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !instagram <url>' }); try { const { data } = await api.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(input)}`); if (data?.data?.url) { const b = await downloadBuffer(data.data.url); await sendStyledMessage(jid, { video: b }); } else throw new Error('No media'); } catch { await sendStyledMessage(jid, { text: '❌ Instagram download failed.' }); } break; }
                case 'facebook': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !facebook <url>' }); try { const { data } = await api.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(input)}`); if (data?.data?.url) { const b = await downloadBuffer(data.data.url); await sendStyledMessage(jid, { video: b }); } else throw new Error('No video'); } catch { await sendStyledMessage(jid, { text: '❌ Facebook download failed.' }); } break; }

                // ── Utility ───────────────────────────────────────────────────
                case 'trt': { const parts = input.split(' '); const lang = parts.pop(); const t = parts.join(' '); if (!t || !lang) return sendStyledMessage(jid, { text: 'Usage: !trt <text> <lang_code>' }); const tr = await translate(t, lang); await sendStyledMessage(jid, { text: `🌐 ${tr}` }); break; }
                case 'check': { if (!input) return sendStyledMessage(jid, { text: 'Usage: !check <host>' }); const host = input.trim(); await sendStyledMessage(jid, { text: `🔍 Checking ${host}…` }); try { const { stdout } = await execFileAsync('nmap', ['-p', '80,443,8080', host], { timeout: 30000 }); await sendStyledMessage(jid, { text: `📡 nmap:\n\`\`\`${stdout.trim().substring(0, 2000)}\`\`\`` }); } catch (e) { await sendStyledMessage(jid, { text: `❌ nmap: ${e.message}` }); } try { const { stdout } = await execAsync(`curl -I -s "${host}"`, { timeout: 15000 }); await sendStyledMessage(jid, { text: `🌐 curl:\n\`\`\`${stdout.trim().substring(0, 2000)}\`\`\`` }); } catch (e) { await sendStyledMessage(jid, { text: `❌ curl: ${e.message}` }); } break; }

                // ── Group Management ──────────────────────────────────────────
                case 'ban': case 'kick': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const t = mentionedJid || quotedKey?.participant; if (!t) return sendStyledMessage(jid, { text: '👆 Mention or reply to a user.' }); await sock.groupParticipantsUpdate(jid, [t], 'remove'); await sendStyledMessage(jid, { text: `🚫 @${t.split('@')[0]} was removed.`, mentions: [t] }); break; }
                case 'promote': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); if (!mentionedJid) return sendStyledMessage(jid, { text: '👆 Mention a user.' }); await sock.groupParticipantsUpdate(jid, [mentionedJid], 'promote'); await sendStyledMessage(jid, { text: `👑 @${mentionedJid.split('@')[0]} promoted to admin!`, mentions: [mentionedJid] }); break; }
                case 'demote': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); if (!mentionedJid) return sendStyledMessage(jid, { text: '👆 Mention a user.' }); await sock.groupParticipantsUpdate(jid, [mentionedJid], 'demote'); await sendStyledMessage(jid, { text: `📉 @${mentionedJid.split('@')[0]} demoted.`, mentions: [mentionedJid] }); break; }
                case 'mute': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const mins = parseInt(input) || 60; await sock.groupSettingUpdate(jid, 'announcement'); setTimeout(() => sock.groupSettingUpdate(jid, 'not_announcement').catch(() => { }), mins * 60000); await sendStyledMessage(jid, { text: `🔇 Group muted for ${mins} minutes.` }); break; }
                case 'unmute': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); await sock.groupSettingUpdate(jid, 'not_announcement'); await sendStyledMessage(jid, { text: '🔊 Group unmuted.' }); break; }
                case 'delete': case 'del': { if (!await isAdmin() && !isOwner) return sendStyledMessage(jid, { text: '❌ Admins only.' }); if (quoted && quotedKey) await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: quotedKey.stanzaId, participant: quotedKey.participant } }); else await sock.sendMessage(jid, { delete: msg.key }); break; }
                case 'tagall': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const meta = await getGroupMeta(); await sendStyledMessage(jid, { text: input || '📢 Attention everyone!', mentions: meta.participants.map(p => p.id) }); break; }

                // ── Warnings ──────────────────────────────────────────────────
                case 'warn': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const t = mentionedJid || quotedKey?.participant; if (!t) return sendStyledMessage(jid, { text: '👆 Mention or reply to a user.' }); if (!warnings[jid]) warnings[jid] = {}; warnings[jid][t] = (warnings[jid][t] || 0) + 1; saveWarnings(); const count = warnings[jid][t]; if (count >= 3) { await sock.groupParticipantsUpdate(jid, [t], 'remove'); await sendStyledMessage(jid, { text: `⛔ @${t.split('@')[0]} has been kicked (3 warnings).`, mentions: [t] }); warnings[jid][t] = 0; saveWarnings(); } else { await sendStyledMessage(jid, { text: `⚠️ @${t.split('@')[0]} warned (${count}/3). ${input || ''}`, mentions: [t] }); } break; }
                case 'warnings': { const t = mentionedJid || quotedKey?.participant; if (!t) return sendStyledMessage(jid, { text: '👆 Mention a user.' }); const count = warnings?.[jid]?.[t] || 0; await sendStyledMessage(jid, { text: `⚠️ @${t.split('@')[0]} has ${count}/3 warnings.`, mentions: [t] }); break; }
                case 'resetwarn': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const t = mentionedJid || quotedKey?.participant; if (!t) return sendStyledMessage(jid, { text: '👆 Mention a user.' }); if (warnings?.[jid]) warnings[jid][t] = 0; saveWarnings(); await sendStyledMessage(jid, { text: `✅ Warnings reset for @${t.split('@')[0]}.`, mentions: [t] }); break; }

                // ── Polls ─────────────────────────────────────────────────────
                case 'poll': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const parts = input.split('|').map(s => s.trim()); if (parts.length < 3) return sendStyledMessage(jid, { text: 'Usage: !poll Question | Opt1 | Opt2 | ...' }); const question = parts[0]; const options = parts.slice(1); settings.polls[jid] = { question, options, votes: {}, voters: {} }; saveSettings(); const optLines = options.map((o, i) => `  ${i + 1}. ${o}`).join('\n'); await sendStyledMessage(jid, { text: `📊 *POLL STARTED*\n\n❓ ${question}\n\n${optLines}\n\nVote with: !vote 1, !vote 2, etc.\nEnd poll: !endpoll` }); break; }
                case 'vote': { if (!isGroup) return; const poll = settings.polls?.[jid]; if (!poll) return sendStyledMessage(jid, { text: '📊 No active poll.' }); if (poll.voters?.[sender]) return sendStyledMessage(jid, { text: '❌ You already voted.' }, { quoted: msg }); const choice = parseInt(input) - 1; if (isNaN(choice) || choice < 0 || choice >= poll.options.length) return sendStyledMessage(jid, { text: `Vote 1–${poll.options.length}` }, { quoted: msg }); poll.votes[choice] = (poll.votes[choice] || 0) + 1; poll.voters[sender] = choice; saveSettings(); await sendStyledMessage(jid, { text: `✅ Voted for: ${poll.options[choice]}` }, { quoted: msg }); break; }
                case 'endpoll': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); const poll = settings.polls?.[jid]; if (!poll) return sendStyledMessage(jid, { text: '📊 No active poll.' }); const results = poll.options.map((o, i) => `  ${i + 1}. ${o} — ${poll.votes[i] || 0} votes`).join('\n'); const maxVotes = Math.max(...poll.options.map((_, i) => poll.votes[i] || 0)); const winner = poll.options[poll.options.findIndex((_, i) => (poll.votes[i] || 0) === maxVotes)]; await sendStyledMessage(jid, { text: `📊 *POLL ENDED*\n❓ ${poll.question}\n\n${results}\n\n🏆 Winner: ${winner}` }); delete settings.polls[jid]; saveSettings(); break; }

                // ── Anti-features ─────────────────────────────────────────────
                case 'antilink': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); settings.antilink[jid] = input === 'on' ? true : input === 'off' ? false : !settings.antilink[jid]; saveSettings(); await sendStyledMessage(jid, { text: `🔗 Anti-link: ${settings.antilink[jid] ? 'ON' : 'OFF'}` }); break; }
                case 'antibadword': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); settings.antibadword[jid] = input === 'on' ? true : input === 'off' ? false : !settings.antibadword[jid]; saveSettings(); await sendStyledMessage(jid, { text: `🚫 Anti-badword: ${settings.antibadword[jid] ? 'ON' : 'OFF'}` }); break; }
                case 'antiflood': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); if (input === 'off') { delete settings.antiFlood[jid]; } else { settings.antiFlood[jid] = parseInt(input) || 5; } saveSettings(); await sendStyledMessage(jid, { text: `⚡ Anti-flood: ${settings.antiFlood[jid] ? `ON (limit: ${settings.antiFlood[jid]}/5s)` : 'OFF'}` }); break; }
                case 'antidelete': { if (!isOwner) return; settings.antidelete = input === 'on' ? true : input === 'off' ? false : !settings.antidelete; saveSettings(); await sendStyledMessage(jid, { text: `🗑️ Anti-delete: ${settings.antidelete ? 'ON' : 'OFF'}` }); break; }
                case 'chatbot': { if (isGroup && !await isAdmin() && !isOwner) return sendStyledMessage(jid, { text: '❌ Admins only.' }); if (isOwner && !isGroup) { settings.chatbotGlobal = input === 'on' ? true : input === 'off' ? false : !settings.chatbotGlobal; saveSettings(); await sendStyledMessage(jid, { text: `🤖 Global chatbot: ${settings.chatbotGlobal ? 'ON' : 'OFF'}` }); } else if (isGroup) { settings.chatbotGroups[jid] = input === 'on' ? true : input === 'off' ? false : !settings.chatbotGroups[jid]; saveSettings(); await sendStyledMessage(jid, { text: `🤖 Group chatbot: ${settings.chatbotGroups[jid] ? 'ON' : 'OFF'}` }); } break; }
                case 'welcome': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); settings.welcome[jid] = input === 'on' ? true : input === 'off' ? false : !settings.welcome[jid]; saveSettings(); await sendStyledMessage(jid, { text: `👋 Welcome messages: ${settings.welcome[jid] ? 'ON' : 'OFF'}` }); break; }
                case 'goodbye': { if (!isGroup || !await isAdmin()) return sendStyledMessage(jid, { text: '❌ Admins only.' }); settings.goodbye[jid] = input === 'on' ? true : input === 'off' ? false : !settings.goodbye[jid]; saveSettings(); await sendStyledMessage(jid, { text: `👋 Goodbye messages: ${settings.goodbye[jid] ? 'ON' : 'OFF'}` }); break; }

                // ── Status Tools (owner) ──────────────────────────────────────
                case 'autostatus': { if (!isOwner) return; settings.autostatus = input === 'on' ? true : input === 'off' ? false : !settings.autostatus; saveSettings(); await sendStyledMessage(jid, { text: `👁 Auto-react statuses: ${settings.autostatus ? 'ON' : 'OFF'}` }); break; }
                case 'statuslike': { if (!isOwner) return; settings.statusLike = input === 'on' ? true : input === 'off' ? false : !settings.statusLike; saveSettings(); await sendStyledMessage(jid, { text: `❤️ Auto-like statuses: ${settings.statusLike ? 'ON' : 'OFF'}` }); break; }
                case 'autostatusview': { if (!isOwner) return; settings.autostatusView = input === 'on' ? true : input === 'off' ? false : !settings.autostatusView; saveSettings(); await sendStyledMessage(jid, { text: `👁 Auto-view statuses: ${settings.autostatusView ? 'ON' : 'OFF'}` }); break; }
                case 'statusshare': { if (!isOwner) return; settings.groupStatusShare = input === 'on' ? true : input === 'off' ? false : !settings.groupStatusShare; saveSettings(); await sendStyledMessage(jid, { text: `📤 Group status sharing: ${settings.groupStatusShare ? 'ON' : 'OFF'}` }); break; }
                case 'addstatusgroup': { if (!isOwner || !isGroup) return sendStyledMessage(jid, { text: '❌ Owner only, in a group.' }); settings.groupStatusGroups[jid] = true; saveSettings(); const meta = await getGroupMeta(); await sendStyledMessage(jid, { text: `✅ "${meta.subject}" added to status-share list.` }); break; }
                case 'removestatusgroup': { if (!isOwner || !isGroup) return sendStyledMessage(jid, { text: '❌ Owner only, in a group.' }); delete settings.groupStatusGroups[jid]; saveSettings(); await sendStyledMessage(jid, { text: '✅ Removed from status-share list.' }); break; }

                // ── Owner Settings ────────────────────────────────────────────
                case 'mode': { if (!isOwner) return; settings.mode = input === 'public' ? 'public' : 'private'; saveSettings(); await sendStyledMessage(jid, { text: `🌐 Mode: ${settings.mode}` }); break; }
                case 'autoreact': { if (!isOwner) return; settings.autoreact = input === 'on' ? true : input === 'off' ? false : !settings.autoreact; saveSettings(); await sendStyledMessage(jid, { text: `✨ Auto-react: ${settings.autoreact ? 'ON' : 'OFF'}` }); break; }
                case 'autotyping': { if (!isOwner) return; settings.autotyping = input === 'on' ? true : input === 'off' ? false : !settings.autotyping; saveSettings(); await sendStyledMessage(jid, { text: `✍️ Auto-typing: ${settings.autotyping ? 'ON' : 'OFF'}` }); break; }
                case 'autoread': { if (!isOwner) return; settings.autoread = input === 'on' ? true : input === 'off' ? false : !settings.autoread; saveSettings(); await sendStyledMessage(jid, { text: `👀 Auto-read: ${settings.autoread ? 'ON' : 'OFF'}` }); break; }
                case 'anticall': { if (!isOwner) return; settings.anticall = input === 'on' ? true : input === 'off' ? false : !settings.anticall; saveSettings(); await sendStyledMessage(jid, { text: `📵 Anti-call: ${settings.anticall ? 'ON' : 'OFF'}` }); break; }
                case 'pmblocker': { if (!isOwner) return; if (input.startsWith('setmsg ')) { settings.pmblockerMsg = input.replace('setmsg ', ''); } else { settings.pmblocker = input === 'on' ? true : input === 'off' ? false : !settings.pmblocker; } saveSettings(); await sendStyledMessage(jid, { text: `🔒 PM blocker: ${settings.pmblocker ? 'ON' : 'OFF'}` }); break; }
                case 'afk': { if (!isOwner) return; settings.afk = input === 'on' ? true : input === 'off' ? false : !settings.afk; saveSettings(); await sendStyledMessage(jid, { text: `💤 AFK mode: ${settings.afk ? 'ON' : 'OFF'}` }); break; }
                case 'afkmsg': { if (!isOwner) return; if (!input) return sendStyledMessage(jid, { text: 'Usage: !afkmsg <message>' }); settings.afkMsg = input; saveSettings(); await sendStyledMessage(jid, { text: '✅ AFK message updated.' }); break; }
                case 'funmode': { if (!isOwner) return; settings.funMode = input === 'on' ? true : input === 'off' ? false : !settings.funMode; saveSettings(); await sendStyledMessage(jid, { text: `🎉 Fun mode: ${settings.funMode ? 'ON' : 'OFF'}` }); break; }

                // ── Schedule ──────────────────────────────────────────────────
                case 'schedule': { if (!isOwner) return; const parts = input.split(' '); const sjid = parts[0]; const mins = parseInt(parts[1]) || 60; const rep = parts[2]?.toLowerCase() === 'yes'; const stxt = parts.slice(3).join(' '); if (!sjid || !stxt) return sendStyledMessage(jid, { text: 'Usage: !schedule <jid> <minutes> <yes/no> <text>' }); settings.schedule.push({ jid: sjid, text: stxt, intervalMs: mins * 60000, nextRun: Date.now() + (mins * 60000), repeat: rep, active: true }); saveSettings(); await sendStyledMessage(jid, { text: `⏰ Scheduled: "${stxt.substring(0, 40)}" in ${mins}m${rep ? ' (repeating)' : ''}` }); break; }
                case 'settings': { if (!isOwner) return; await sendStyledMessage(jid, { text: `📋 Settings:\n\`\`\`${JSON.stringify(settings, null, 2).substring(0, 3000)}\`\`\`` }); break; }
                case 'cleartmp': { if (!isOwner) return; fs.readdirSync(TEMP_DIR).forEach(f => { try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch { } }); await sendStyledMessage(jid, { text: '🧹 Temp folder cleared.' }); break; }

                default: await sendStyledMessage(jid, { text: '❌ Unknown command. Type !menu for help.' });
            }
        } catch (err) {
            console.error('Command error:', err);
            await sendStyledMessage(jid, { text: '⚠️ An error occurred.' }).catch(() => { });
        }
    });

    // ─── Group join/leave events ──────────────────────────────────
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        try {
            if (action === 'add' && settings.welcome?.[id]) {
                for (const p of participants) {
                    try { const meta = await sock.groupMetadata(id); await sendStyledMessage(id, { text: `👋 Welcome @${p.split('@')[0]} to *${meta.subject}*! 🎉\n\nWe're glad to have you here. Type !menu to see what I can do! 🇻🇦`, mentions: [p] }); } catch { }
                }
            } else if ((action === 'remove' || action === 'leave') && settings.goodbye?.[id]) {
                for (const p of participants) {
                    try { await sendStyledMessage(id, { text: `👋 @${p.split('@')[0]} has left the group. Goodbye! 🇻🇦`, mentions: [p] }); } catch { }
                }
            }
        } catch { }
    });
}

// ==================== TELEGRAM BOT (pairing & status) ====================
const telBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let pairingInProgress = false;

telBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const statusMsg = whatsAppSocket
        ? `✅ WhatsApp connected: +${botNumber}`
        : `⚠️  WhatsApp not connected. Use /pair 1234567890 to link your account.`;
    await telBot.sendMessage(chatId,
        `🇻🇦 <b>TARAGON SQUAD TRS</b> — Combined Bot\n\n` +
        `${statusMsg}\n\n` +
        `Commands:\n` +
        `/pair <phone> - start WhatsApp pairing\n` +
        `/status - show connection status\n` +
        `/logout - disconnect WhatsApp\n\n` +
        `After pairing, all WhatsApp commands (!menu) work in your linked phone.`,
        { parse_mode: 'HTML' }
    );
});

telBot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (whatsAppSocket) {
        await telBot.sendMessage(chatId, `✅ WhatsApp connected as +${botNumber}\nUptime: ${formatUptime()}`);
    } else {
        await telBot.sendMessage(chatId, `⚠️  WhatsApp not connected.`);
    }
});

telBot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    if (!whatsAppSocket) return telBot.sendMessage(chatId, '⚠️  No active WhatsApp connection.');
    try { whatsAppSocket.end(); } catch { }
    whatsAppSocket = null;
    botNumber = null;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await telBot.sendMessage(chatId, '🛑 WhatsApp disconnected. You can pair again with /pair.');
});

telBot.onText(/\/pair/, async (msg) => {
    const chatId = msg.chat.id;
    if (pairingInProgress) return telBot.sendMessage(chatId, '⏳ A pairing is already in progress. Wait or use /cancel.');
    const phone = msg.text.split(' ')[1]?.replace(/\D/g, '');
    if (!phone || phone.length < 10) return telBot.sendMessage(chatId, '❌ Please provide a valid phone number with country code.\nExample: /pair 1234567890');
    pairingInProgress = true;
    await startPairing(chatId, phone);
});

telBot.onText(/\/cancel/, async (msg) => {
    if (pairingInProgress) {
        pairingInProgress = false;
        await telBot.sendMessage(msg.chat.id, '🛑 Pairing cancelled.');
    } else {
        await telBot.sendMessage(msg.chat.id, 'ℹ️  No pairing in progress.');
    }
});

async function startPairing(chatId, phone) {
    await telBot.sendMessage(chatId, '⏳ Connecting to WhatsApp…');
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: false,
        });

        await new Promise(r => setTimeout(r, 3000));
        const code = await sock.requestPairingCode(phone);
        console.log(`📱 Pairing code for ${phone}: ${code}`);
        await telBot.sendMessage(chatId,
            `📲  WhatsApp Pairing Code\n\n` +
            `<b>${code}</b>\n\n` +
            `Steps:\n` +
            `1. Open WhatsApp on your phone\n` +
            `2. Tap ⋮ → Linked Devices\n` +
            `3. Tap Link a Device\n` +
            `4. Enter the code above\n\n` +
            `Waiting for you to link… (timeout 3 minutes)`,
            { parse_mode: 'HTML' }
        );

        let connected = false;
        let timedOut = false;
        const timeout = setTimeout(async () => {
            if (!connected) {
                timedOut = true;
                await telBot.sendMessage(chatId, '⏰ Timed out. Please try again with /pair.');
                pairingInProgress = false;
                sock.end();
            }
        }, 180_000);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (timedOut || connected) return;
            if (connection === 'open') {
                connected = true;
                clearTimeout(timeout);
                const num = sock.user.id.split(':')[0];
                whatsAppSocket = sock;
                botNumber = num;
                botStartTime = Date.now();
                pairingInProgress = false;
                await telBot.sendMessage(chatId, `✅ WhatsApp connected as +${num}! The bot is now live. All WhatsApp commands (!menu) work.`);
                console.log(`✅ WhatsApp paired: +${num}`);
                setupBot(sock, num);
            } else if (connection === 'close') {
                if (!connected) {
                    clearTimeout(timeout);
                    pairingInProgress = false;
                    await telBot.sendMessage(chatId, '❌ Connection closed unexpectedly. Try again.');
                    sock.end();
                }
            }
        });
    } catch (err) {
        pairingInProgress = false;
        await telBot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
}

function formatUptime() {
    if (!botStartTime) return '0h 0m 0s';
    const u = Date.now() - botStartTime;
    const h = Math.floor(u / 3600000);
    const m = Math.floor((u % 3600000) / 60000);
    const s = Math.floor((u % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
}

// ==================== EXPRESS SERVER ====================
const app = express();
const server = http.createServer(app);
app.get('/', (req, res) => res.send('Taragon Bot is running.'));
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: !!whatsAppSocket, botNumber }));

server.listen(PORT, () => {
    console.log(`\n🇻🇦  TARAGON SQUAD TRS  —  Telegram + WhatsApp Bot\n   Port: ${PORT}\n   Telegram: @taragon_bot (or your configured bot)\n`);
});

// ==================== AUTO‑RECONNECT ON BOOT ====================
(async () => {
    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.log('ℹ️  No previous WhatsApp session found. Use /pair in Telegram.');
        return;
    }
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: true,
        });
        sock.ev.on('connection.update', async (u) => {
            if (u.connection === 'open') {
                const num = sock.user.id.split(':')[0];
                whatsAppSocket = sock;
                botNumber = num;
                botStartTime = Date.now();
                console.log(`✅ WhatsApp reconnected: +${num}`);
                setupBot(sock, num);
            }
            if (u.connection === 'close') {
                const shouldReconnect = u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 5s…');
                    setTimeout(() => process.exit(1), 5000);
                } else {
                    console.log('❌ Logged out. Please re-pair via Telegram.');
                    whatsAppSocket = null;
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
                }
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        console.log('⚠️  Auto-reconnect error:', err.message);
    }
})();
