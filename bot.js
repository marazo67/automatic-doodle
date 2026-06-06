// ======================== TARAGON TELEGRAM BOT (WITH WHATSAPP PAIRING) ========================
// Run: node telegram_bot.js
// Install: npm install node-telegram-bot-api axios yt-search @whiskeysockets/baileys pino
// ==============================================================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ==================== NEW: Baileys for WhatsApp pairing ====================
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// ==================== YOUR TELEGRAM BOT TOKEN ====================
const TOKEN = '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E';
// =================================================================

if (!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ Please set your bot token in the script.');
    process.exit(1);
}

// Create bot with polling
const bot = new TelegramBot(TOKEN, { polling: true });

// ==================== GLOBAL SETTINGS ====================
let settings = {
    mode: 'public',          // 'public' or 'private' (owner only for private)
    chatbotGlobal: true,
    funMode: true,
    ownerId: null,
    admins: [],
};
let startTime = Date.now();

// Conversation memory
const chatMemory = new Map();
const userInfo = new Map();

// ==================== PAIRING SYSTEM (NEW) ====================
const PAIR_SESSIONS_DIR = path.join(__dirname, 'pair_sessions');
if (!fs.existsSync(PAIR_SESSIONS_DIR)) fs.mkdirSync(PAIR_SESSIONS_DIR, { recursive: true });

// active pairings: chatId -> { socket, authDir, timeout, phone }
const activePairings = new Map();

/**
 * Cleans up a pairing session (closes socket, deletes auth folder, clears timeout)
 */
async function cleanupPairing(chatId, deleteFiles = true) {
    const pairing = activePairings.get(chatId);
    if (!pairing) return;
    if (pairing.timeout) clearTimeout(pairing.timeout);
    if (pairing.socket) {
        try { pairing.socket.end(undefined); } catch (e) {}
        try { pairing.socket.ws?.close(); } catch (e) {}
    }
    if (deleteFiles && pairing.authDir && fs.existsSync(pairing.authDir)) {
        fs.rmSync(pairing.authDir, { recursive: true, force: true });
    }
    activePairings.delete(chatId);
}

/**
 * Recursively reads a folder and returns an object mapping relative paths to file content (utf8 or base64 for binary).
 * We'll store everything as utf8 strings (creds are JSON, keys are base64‑encoded already).
 */
function readAuthFolderToJSON(folderPath) {
    const files = {};
    function walk(dir, relPath = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const rel = relPath ? path.join(relPath, entry.name) : entry.name;
            if (entry.isDirectory()) {
                walk(full, rel);
            } else {
                const content = fs.readFileSync(full, 'utf8');
                files[rel] = content;
            }
        }
    }
    walk(folderPath);
    return files;
}

/**
 * Generates a session ID (e.g., TRS-XXXXXXX) and returns it along with base64 blob.
 */
function generateSessionId(phone) {
    const random = Math.random().toString(36).substring(2, 12).toUpperCase();
    return `TRS-${random}`;
}

/**
 * Performs the pairing flow for a given phone number.
 * Sends progress messages via the provided `sendMessage` function.
 */
async function startPairing(chatId, phone, sendMessage) {
    // Check if already pairing for this chat
    if (activePairings.has(chatId)) {
        await sendMessage('❌ A pairing session is already active. Use /pair_cancel first.');
        return;
    }

    const authDir = path.join(PAIR_SESSIONS_DIR, `pair_${chatId}_${Date.now()}`);
    fs.mkdirSync(authDir, { recursive: true });

    let socket = null;
    let timeout = null;
    let isConnected = false;

    const cleanup = () => cleanupPairing(chatId, true);
    const onError = async (errMsg) => {
        if (isConnected) return;
        await sendMessage(`❌ Pairing failed: ${errMsg}`);
        cleanup();
    };

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        socket = makeWASocket({
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

        // Request pairing code
        const code = await socket.requestPairingCode(phone);
        await sendMessage(`🔐 *Pairing code:* \`${code}\`\n\nEnter this code on your WhatsApp → Linked Devices → Link a Device. The code expires in 2 minutes.`);

        // Set timeout
        timeout = setTimeout(async () => {
            if (!isConnected) {
                await sendMessage('⏰ Pairing timed out. Please start again with /pair.');
                cleanup();
            }
        }, 120000);

        // Store pairing data
        activePairings.set(chatId, { socket, authDir, timeout, phone });

        // Listen for connection update
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open' && !isConnected) {
                isConnected = true;
                clearTimeout(timeout);
                const fullNumber = socket.user.id.split(':')[0];

                // Read auth folder and compress to base64 JSON
                const fileMap = readAuthFolderToJSON(authDir);
                const base64Blob = Buffer.from(JSON.stringify(fileMap, null, 0)).toString('base64');
                const sessionId = generateSessionId(phone);

                // Prepare session data text
                const sessionData = `SESSION_ID=${sessionId}\nSESSION_BLOB=${base64Blob}\n\n# Copy these into your Render environment variables.\n# Then deploy the WhatsApp bot (bot.js).`;

                const tempFile = path.join(PAIR_SESSIONS_DIR, `session_${chatId}.txt`);
                fs.writeFileSync(tempFile, sessionData, 'utf8');

                // Send the session file to the user
                await bot.sendDocument(chatId, tempFile, {
                    caption: `✅ *WhatsApp linked successfully!*\n\n📱 Number: +${fullNumber}\n🆔 Session ID: \`${sessionId}\`\n\n📄 The attached file contains your SESSION_ID and SESSION_BLOB.\n\n👉 *How to deploy:*\n1. Upload the WhatsApp bot code (bot.js) to Render.\n2. Add environment variables:\n   - \`SESSION_ID\` = ${sessionId}\n   - \`SESSION_BLOB\` = (the long base64 string from the file)\n3. Deploy and enjoy! 🇻🇦`,
                    parse_mode: 'Markdown'
                });

                // Cleanup the temporary file and auth dir
                fs.unlinkSync(tempFile);
                cleanup();
                await sendMessage('🎉 Pairing complete! You can now deploy the WhatsApp bot using the session above.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut && !isConnected) {
                    await sendMessage('⚠️ Connection closed unexpectedly. Please try again.');
                }
                cleanup();
            }
        });

        socket.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error('Pairing error:', err);
        await onError(err.message);
    }
}

// ==================== AI APIs (unchanged) ====================
const ALL_AI_APIS = [
    { name:'ZellAPI',       url:(q)=>`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`,                                             extract:(d)=>d?.result },
    { name:'Vapis Gemini',  url:(q)=>`https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`,                                                   extract:(d)=>d?.message },
    { name:'Siputzx',       url:(q)=>`https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`,                                extract:(d)=>d?.data },
    { name:'Ryzen',         url:(q)=>`https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`,                                        extract:(d)=>d?.answer },
    { name:'GiftedPro',     url:(q)=>`https://api.giftedtech.my.id/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(q)}`,                    extract:(d)=>d?.answer },
    { name:'ZellBackup',    url:(q)=>`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent('Reply to: '+q)}`,                                 extract:(d)=>d?.result },
];

async function getAIResponse(userMessage, userId) {
    const messages = chatMemory.get(userId) || [];
    const context = messages.slice(-5).join(' | ');
    const prompt = `You're Scottie Kiidrsa, a real person. Reply in 1-2 lines max. Use Hinglish naturally. Be savage if abused, sweet if treated well. NEVER say you're AI. Context: ${context}. Message: ${userMessage}`;

    const promises = ALL_AI_APIS.map(async (api) => {
        try {
            const res = await axios.get(api.url(prompt), { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const answer = api.extract(res.data);
            if (answer && typeof answer === 'string' && answer.length > 2) {
                return answer.trim()
                    .replace(/^(AI|Bot|Assistant|Answer|Response|Reply):?\s*/i, '')
                    .replace(/Remember:.*$|IMPORTANT:.*$|CORE RULES:.*$/g, '')
                    .trim();
            }
        } catch {}
        return null;
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) return r.value;
    }
    const fallbacks = ["Haan bhai! 😊","Kya scene hai? 😎","Hmm soch raha hu... 🤔","Kya baat hai! 🔥","Bhai tu legend hai! 👑"];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// ==================== FUN QUICK REPLIES (unchanged) ====================
const FUN_TRIGGERS = {
    'good morning': ['🌅 Good morning! Have a blessed day! ☀️', '🌞 Rise and shine! Morning bhai! 🇻🇦'],
    'good night':   ['🌙 Sweet dreams! 💤', '😴 Good night! Rest well king 👑'],
    'gm':           ['🌅 GM! Taragon squad is live! 🇻🇦'],
    'gn':           ['🌙 GN! Stay blessed! ✨'],
    'lol':          ['😂😂😂', 'Haha bhai ded 💀'],
    'bruh':         ['💀 Same bhai same', '😭 Bhai bruh moment'],
    'gg':           ['🎮 GG WP!', '🏆 EZ Clap!'],
    'fr':           ['💯 FR FR no cap', '🔥 Facts bhai'],
    'ngl':          ['😅 Honest hour!', '👀 No cap detected'],
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

// ==================== DOWNLOAD HELPERS (unchanged) ====================
const AXIOS_DEFAULTS = { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };
const tryRequest = async (fn, attempts = 3) => {
    for (let i = 1; i <= attempts; i++) {
        try { return await fn(); }
        catch (err) { if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i)); else throw err; }
    }
};

const downloadBuffer = async (url) => (await axios.get(url, { responseType: 'arraybuffer' })).data;

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
        { url:`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(video.url)}&format=mp3`, extract:(d)=>d?.data?.downloadURL },
        { url:`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(video.url)}`,        extract:(d)=>d?.data?.data?.download_url },
        { url:`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(video.url)}`,extract:(d)=>d?.data?.dl },
    ];
    for (const a of apis) {
        try {
            const res = await tryRequest(() => axios.get(a.url, AXIOS_DEFAULTS));
            const url = a.extract(res);
            if (url) {
                const buffer = await downloadBuffer(url);
                return { buffer, title: res.data?.title || video.title, mime: 'audio/mpeg', ext: 'mp3' };
            }
        } catch {}
    }
    try {
        const out = path.join(__dirname, `audio_${Date.now()}.mp3`);
        await execAsync(`yt-dlp -x --audio-format mp3 -o "${out}" "${video.url}"`, { timeout: 120000 });
        if (fs.existsSync(out)) {
            const buffer = fs.readFileSync(out);
            fs.unlinkSync(out);
            return { buffer, title: video.title, mime: 'audio/mpeg', ext: 'mp3' };
        }
    } catch {}
    throw new Error('All download sources failed.');
}

async function downloadVideo(url) {
    try {
        const { data } = await tryRequest(() => axios.get(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(url)}`, AXIOS_DEFAULTS));
        if (data?.data?.download_url) {
            const buffer = await downloadBuffer(data.data.download_url);
            return { buffer, title: data.data.title || 'Video' };
        }
    } catch {}
    try {
        const { data } = await tryRequest(() => axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(url)}`, AXIOS_DEFAULTS));
        if (data?.result?.mp4) {
            const buffer = await downloadBuffer(data.result.mp4);
            return { buffer, title: data.result.title || 'Video' };
        }
    } catch {}
    try {
        const out = path.join(__dirname, `video_${Date.now()}.mp4`);
        await execAsync(`yt-dlp -f "best[ext=mp4]" -o "${out}" "${url}"`, { timeout: 300000 });
        if (fs.existsSync(out)) {
            const buffer = fs.readFileSync(out);
            fs.unlinkSync(out);
            return { buffer, title: 'Video' };
        }
    } catch {}
    throw new Error('Failed to download video');
}

async function downloadTikTok(url) {
    const res = await tryRequest(() =>
        axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, { timeout: 15000 })
    );
    if (res?.data?.data) {
        const d = res.data.data;
        const u = d.urls?.[0] || d.video_url || d.url || d.download_url;
        if (u) return { videoUrl: u, title: d.metadata?.title || 'TikTok' };
    }
    throw new Error('Failed');
}

async function translate(text, targetLang) {
    try {
        const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`);
        return res.data[0][0][0];
    } catch { return text; }
}

// ==================== COMMAND HANDLER (UPDATED WITH PAIRING) ====================
bot.on('message', async (msg) => {
    if (!msg.text && !msg.caption) return;
    const text = (msg.text || msg.caption).trim();
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // Owner & Admin checks
    const isOwner = userId === settings.ownerId;
    const isAdmin = settings.admins.includes(userId) || isOwner;

    // Private mode restriction
    if (settings.mode === 'private' && !isOwner && text.startsWith('/') && !['/start','/help','/menu'].includes(text.split(' ')[0])) {
        return bot.sendMessage(chatId, '🔒 Bot is in private mode. Only the owner can use commands.');
    }

    // Chatbot memory
    if (!text.startsWith('/') && !isGroup) {
        const msgs = chatMemory.get(userId) || [];
        msgs.push(text);
        if (msgs.length > 20) msgs.shift();
        chatMemory.set(userId, msgs);
    }

    // AI Chatbot
    if (settings.chatbotGlobal && !text.startsWith('/') && !isGroup) {
        const reply = await getAIResponse(text, userId);
        return bot.sendMessage(chatId, reply);
    }

    if (isGroup && !text.startsWith('/') && settings.chatbotGlobal && msg.entities) {
        const botUsername = (await bot.getMe()).username;
        const mentioned = msg.entities.some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length) === `@${botUsername}`);
        if (mentioned) {
            const cleanText = text.replace(`@${botUsername}`, '').trim();
            if (cleanText) {
                const reply = await getAIResponse(cleanText, userId);
                return bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
            }
        }
    }

    // Fun mode
    if (settings.funMode && !text.startsWith('/') && !isGroup) {
        const fun = getFunReply(text);
        if (fun) return bot.sendMessage(chatId, fun);
    }

    if (!text.startsWith('/')) return;

    const args = text.slice(1).split(' ');
    const command = args.shift().toLowerCase();
    const input = args.join(' ');

    const reply = (msgText, extra = {}) => bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id, ...extra });

    try {
        switch (command) {
            // ========== BASIC ==========
            case 'start':
                const startMsg = `🇻🇦 *TARAGON SQUAD TRS* — Telegram Bot\n\n` +
                                 `Send any message to chat with AI.\n` +
                                 `Use /menu to see all commands.\n\n` +
                                 `👑 Owner: ${settings.ownerId ? `[${settings.ownerId}](tg://user?id=${settings.ownerId})` : 'not set'}\n` +
                                 `🔗 New: /pair <phone> to link a WhatsApp account and get session ID for deployment.`;
                return bot.sendMessage(chatId, startMsg, { parse_mode: 'Markdown' });

            case 'menu':
            case 'help':
                const menu = `╭━━━❰ *TARAGON BOT* ❱━━━╮
┃ ⚡ Mode: ${settings.mode}  |  Uptime: ${formatUptime()}
╰━━━━━━━━━━━━━━━━━━━━╯

*🌐 GENERAL*
  /ping  /alive  /menu

*🤖 AI*
  /gpt <question>  /gemini <question>  /imagine <prompt>

*📥 DOWNLOADERS*
  /play <song/url>  /ytmp3 <url>  /ytmp4 <url>
  /tiktok <url>  /spotify <song>  /instagram <url>  /facebook <url>

*🛠 UTILITIES*
  /trt <text> <lang>  /check <host>

*🔗 WHATSAPP PAIRING* (owner only)
  /pair <phone>           – start pairing & get session file
  /pair_status            – check active pairing
  /pair_cancel            – cancel current pairing

*🔒 OWNER*
  /setowner               – claim ownership
  /mode public|private
  /chatbot on|off
  /funmode on|off
  /owner
  /shutdown`;
                return bot.sendMessage(chatId, menu, { parse_mode: 'Markdown' });

            case 'ping':
                const start = Date.now();
                const msgSent = await bot.sendMessage(chatId, '🏓 Pinging...');
                const end = Date.now();
                bot.editMessageText(`🏓 Pong! ${end - start}ms`, { chat_id: chatId, message_id: msgSent.message_id });
                break;

            case 'alive':
                reply(`✅ *TARAGON BOT*\n⏰ Uptime: ${formatUptime()}\n🌐 Mode: ${settings.mode}\n🤖 Chatbot: ${settings.chatbotGlobal ? 'ON' : 'OFF'}`);
                break;

            case 'owner':
                reply(`👑 Owner: ${settings.ownerId ? `[${settings.ownerId}](tg://user?id=${settings.ownerId})` : 'Not set'}`);
                break;

            // ========== OWNER CLAIM ==========
            case 'setowner':
                if (settings.ownerId) return reply('👑 An owner is already set.');
                settings.ownerId = userId;
                reply('✅ You are now the bot owner. Use /menu to see all commands.');
                break;

            // ========== MODE TOGGLE ==========
            case 'mode':
                if (!isOwner) return reply('❌ Only owner can change mode.');
                if (input === 'public') settings.mode = 'public';
                else if (input === 'private') settings.mode = 'private';
                else return reply('Usage: /mode public|private');
                reply(`🌐 Mode set to: ${settings.mode}`);
                break;

            case 'chatbot':
                if (!isOwner) return reply('❌ Owner only.');
                if (input === 'on') settings.chatbotGlobal = true;
                else if (input === 'off') settings.chatbotGlobal = false;
                else return reply('Usage: /chatbot on|off');
                reply(`🤖 Global chatbot: ${settings.chatbotGlobal ? 'ON' : 'OFF'}`);
                break;

            case 'funmode':
                if (!isOwner) return reply('❌ Owner only.');
                if (input === 'on') settings.funMode = true;
                else if (input === 'off') settings.funMode = false;
                else return reply('Usage: /funmode on|off');
                reply(`🎉 Fun mode: ${settings.funMode ? 'ON' : 'OFF'}`);
                break;

            case 'shutdown':
                if (!isOwner) return reply('❌ Owner only.');
                await reply('🛑 Shutting down...');
                process.exit(0);

            // ========== AI ==========
            case 'gpt':
            case 'gemini':
                if (!input) return reply(`Usage: /${command} <question>`);
                const aiReply = await getAIResponse(input, userId);
                reply(`🤖 ${aiReply}`);
                break;

            case 'imagine':
                if (!input) return reply('Usage: /imagine <prompt>');
                try {
                    const { data } = await axios.get(`https://api.siputzx.my.id/api/ai/stablediffusion?prompt=${encodeURIComponent(input)}`);
                    const url = typeof data === 'string' ? data : data?.url || data?.image;
                    if (url) {
                        const buffer = await downloadBuffer(url);
                        await bot.sendPhoto(chatId, buffer, { caption: input, reply_to_message_id: msg.message_id });
                    } else throw new Error();
                } catch {
                    reply('❌ Image generation failed.');
                }
                break;

            // ========== DOWNLOADERS ==========
            case 'play':
            case 'ytmp3':
                if (!input) return reply('Usage: /play <song name or YouTube URL>');
                reply('⏳ Downloading audio...');
                try {
                    const { buffer, title, mime, ext } = await downloadSong(input);
                    await bot.sendAudio(chatId, buffer, { title, performer: 'Taragon', fileName: `${title}.${ext}` }, { contentType: mime });
                } catch (e) {
                    reply(`❌ ${e.message}`);
                }
                break;

            case 'ytmp4':
                if (!input) return reply('Usage: /ytmp4 <YouTube URL>');
                reply('⏳ Downloading video...');
                try {
                    const { buffer, title } = await downloadVideo(input);
                    await bot.sendVideo(chatId, buffer, { caption: title });
                } catch (e) {
                    reply(`❌ ${e.message}`);
                }
                break;

            case 'tiktok':
                if (!input) return reply('Usage: /tiktok <TikTok URL>');
                reply('⏳ Downloading TikTok...');
                try {
                    const { videoUrl, title } = await downloadTikTok(input);
                    const buffer = await downloadBuffer(videoUrl);
                    await bot.sendVideo(chatId, buffer, { caption: title });
                } catch (e) {
                    reply(`❌ ${e.message}`);
                }
                break;

            case 'spotify':
                if (!input) return reply('Usage: /spotify <song name>');
                try {
                    const { data } = await axios.get(`https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(input)}`, { timeout: 20000 });
                    if (data?.status && data?.result?.audio) {
                        const r = data.result;
                        const cap = `🎵 ${r.title}\n👤 ${r.artist || ''}`;
                        if (r.thumbnails) {
                            await bot.sendPhoto(chatId, r.thumbnails, { caption: cap });
                        }
                        const audioBuffer = await downloadBuffer(r.audio);
                        await bot.sendAudio(chatId, audioBuffer, { title: r.title, performer: r.artist, fileName: `${r.title}.mp3` });
                    } else throw new Error('No audio');
                } catch {
                    reply('❌ Spotify download failed.');
                }
                break;

            case 'instagram':
                if (!input) return reply('Usage: /instagram <Instagram URL>');
                try {
                    const { data } = await axios.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(input)}`);
                    if (data?.data?.url) {
                        const buffer = await downloadBuffer(data.data.url);
                        await bot.sendVideo(chatId, buffer);
                    } else throw new Error();
                } catch {
                    reply('❌ Instagram download failed.');
                }
                break;

            case 'facebook':
                if (!input) return reply('Usage: /facebook <Facebook video URL>');
                try {
                    const { data } = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(input)}`);
                    if (data?.data?.url) {
                        const buffer = await downloadBuffer(data.data.url);
                        await bot.sendVideo(chatId, buffer);
                    } else throw new Error();
                } catch {
                    reply('❌ Facebook download failed.');
                }
                break;

            // ========== UTILITIES ==========
            case 'trt':
                const parts = input.split(' ');
                const lang = parts.pop();
                const toTranslate = parts.join(' ');
                if (!toTranslate || !lang) return reply('Usage: /trt <text> <lang_code>');
                const translated = await translate(toTranslate, lang);
                reply(`🌐 *Translation:*\n${translated}`);
                break;

            case 'check':
                if (!input) return reply('Usage: /check <host>');
                const host = input.trim();
                reply(`🔍 Checking ${host}...`);
                try {
                    const { stdout } = await execFileAsync('nmap', ['-p','80,443,8080',host], { timeout: 30000 });
                    reply(`📡 nmap:\n<pre>${stdout.trim().substring(0,2000)}</pre>`);
                } catch (e) {
                    reply(`❌ nmap: ${e.message}`);
                }
                try {
                    const { stdout } = await execAsync(`curl -I -s "${host}"`, { timeout: 15000 });
                    reply(`🌐 curl:\n<pre>${stdout.trim().substring(0,2000)}</pre>`);
                } catch (e) {
                    reply(`❌ curl: ${e.message}`);
                }
                break;

            // ========== NEW PAIRING COMMANDS ==========
            case 'pair':
                if (!isOwner) return reply('❌ Only the bot owner can pair WhatsApp accounts.');
                if (!input) return reply('Usage: `/pair <phone>`\nExample: `/pair 27785028986` (include country code)');
                const phone = input.replace(/\D/g, '');
                if (phone.length < 10) return reply('❌ Invalid phone number. Include country code (e.g., 27785028986)');
                // Start pairing asynchronously, but don't block
                startPairing(chatId, phone, async (msgText, extra = {}) => {
                    return bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...extra });
                }).catch(err => reply(`❌ Pairing error: ${err.message}`));
                break;

            case 'pair_status':
                if (!isOwner) return reply('❌ Owner only.');
                if (activePairings.has(chatId)) {
                    const p = activePairings.get(chatId);
                    reply(`🔄 Active pairing for +${p.phone}\nStatus: waiting for WhatsApp connection.\nUse /pair_cancel to stop.`);
                } else {
                    reply('ℹ️ No active pairing session. Start one with `/pair <phone>`.');
                }
                break;

            case 'pair_cancel':
                if (!isOwner) return reply('❌ Owner only.');
                if (activePairings.has(chatId)) {
                    await cleanupPairing(chatId, true);
                    reply('❌ Pairing cancelled and session files removed.');
                } else {
                    reply('ℹ️ No active pairing to cancel.');
                }
                break;

            default:
                reply('❓ Unknown command. Type /menu for help.');
        }
    } catch (err) {
        console.error('Command error:', err);
        reply('⚠️ Something went wrong. Please try again later.');
    }
});

// ==================== HELPER ====================
function formatUptime() {
    const u = Date.now() - startTime;
    const h = Math.floor(u / 3600000);
    const m = Math.floor((u % 3600000) / 60000);
    const s = Math.floor((u % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
}

console.log('🤖 Taragon Telegram Bot started successfully!');
console.log(`   Bot: @${bot.botInfo?.username}`);
console.log('   Send /start to begin.');
console.log('   WhatsApp pairing enabled — use /pair <phone> (owner only)');
