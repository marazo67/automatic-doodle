// ======================== TARAGON TELEGRAM BOT ========================
// Run: node telegram_bot.js
// Install: npm install node-telegram-bot-api axios yt-search
// Optional: yt-dlp + ffmpeg for reliable YouTube downloads
// ======================================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ==================== YOUR TELEGRAM BOT TOKEN ====================
const TOKEN = '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E';
// =================================================================

if (!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ Please set your bot token in the script.');
    process.exit(1);
}

// Create bot with polling
const bot = new TelegramBot(TOKEN, { polling: true });

// ==================== GLOBAL SETTINGS (similar to original) ====================
let settings = {
    mode: 'public',          // 'public' or 'private' (owner only for private)
    chatbotGlobal: true,     // AI replies to every user
    funMode: true,           // quick fun replies like "gm", "lol"
    ownerId: null,           // set automatically from /setowner
    admins: [],              // additional admin user IDs
};
// We'll store owner info once set
let startTime = Date.now();

// Conversation memory (same as WhatsApp version)
const chatMemory = new Map(); // userId -> array of messages
const userInfo = new Map();   // userId -> extracted name/age/location

// ==================== AI APIs (identical to original) ====================
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

// ==================== FUN QUICK REPLIES ====================
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

// ==================== DOWNLOAD HELPERS (same as original) ====================
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

    // Try various APIs for audio
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
    // Fallback using yt-dlp
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
    // try APIs
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
    // fallback yt-dlp
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

// ==================== COMMAND HANDLER ====================
bot.on('message', async (msg) => {
    if (!msg.text && !msg.caption) return; // ignore non-text messages
    const text = (msg.text || msg.caption).trim();
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    // ------ Owner & Admin checks ------
    const isOwner = userId === settings.ownerId;
    const isAdmin = settings.admins.includes(userId) || isOwner;

    // ------ Private mode (only owner can use commands) ------
    if (settings.mode === 'private' && !isOwner && text.startsWith('/')) {
        if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/menu')) {
            // allow /start and /help for everyone
        } else {
            return bot.sendMessage(chatId, '🔒 Bot is in private mode. Only the owner can use commands.');
        }
    }

    // ------ Chatbot memory update ------
    if (!text.startsWith('/') && !isGroup) {
        // store non-command private messages for AI context
        const msgs = chatMemory.get(userId) || [];
        msgs.push(text);
        if (msgs.length > 20) msgs.shift();
        chatMemory.set(userId, msgs);
    }

    // ------ AI Chatbot (if global or group mention) ------
    if (settings.chatbotGlobal && !text.startsWith('/') && !isGroup) {
        // respond in DM automatically
        const reply = await getAIResponse(text, userId);
        return bot.sendMessage(chatId, reply);
    }

    if (isGroup && !text.startsWith('/') && settings.chatbotGlobal && msg.entities) {
        // check if bot is mentioned in group
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

    // ------ Fun mode quick replies (only in DM or if group mention) ------
    if (settings.funMode && !text.startsWith('/') && !isGroup) {
        const fun = getFunReply(text);
        if (fun) return bot.sendMessage(chatId, fun);
    }

    // ------ Commands ------
    if (!text.startsWith('/')) return;

    const args = text.slice(1).split(' ');
    const command = args.shift().toLowerCase();
    const input = args.join(' ');

    // Helper to reply inline
    const reply = (msgText) => bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', reply_to_message_id: msg.message_id });

    try {
        switch (command) {
            // ========== BASIC ==========
            case 'start':
                const startMsg = `🇻🇦 <b>TARAGON SQUAD TRS</b> — Telegram Bot\n\n` +
                                 `Send any message to chat with AI.\n` +
                                 `Use <b>/menu</b> to see all commands.\n\n` +
                                 `👑 Owner: not set yet. Use <b>/setowner</b> to claim ownership.`;
                return bot.sendMessage(chatId, startMsg, { parse_mode: 'HTML' });

            case 'menu':
            case 'help':
                const menu = `╭━━━❰ <b>TARAGON BOT</b> ❱━━━╮
┃ ⚡ Mode: ${settings.mode}  |  Uptime: ${formatUptime()}
╰━━━━━━━━━━━━━━━━━━━━╯

<b>🌐 GENERAL</b>
  /ping  /alive  /menu

<b>🤖 AI</b>
  /gpt &lt;question&gt;
  /gemini &lt;question&gt;
  /imagine &lt;prompt&gt;

<b>📥 DOWNLOADERS</b>
  /play &lt;song/url&gt;
  /ytmp3 &lt;url&gt;
  /ytmp4 &lt;url&gt;
  /tiktok &lt;url&gt;
  /spotify &lt;song&gt;
  /instagram &lt;url&gt;
  /facebook &lt;url&gt;

<b>🛠 UTILITIES</b>
  /trt &lt;text&gt; &lt;lang&gt;
  /check &lt;host&gt;

<b>🔒 OWNER</b>
  /setowner (first person to use it becomes owner)
  /mode public|private
  /chatbot on|off
  /funmode on|off
  /owner
  /shutdown (stop bot)`;
                return bot.sendMessage(chatId, menu, { parse_mode: 'HTML' });

            case 'ping':
                const start = Date.now();
                const msgSent = await bot.sendMessage(chatId, '🏓 Pinging...');
                const end = Date.now();
                bot.editMessageText(`🏓 Pong! ${end - start}ms`, { chat_id: chatId, message_id: msgSent.message_id });
                break;

            case 'alive':
                reply(`✅ <b>TARAGON BOT</b>\n⏰ Uptime: ${formatUptime()}\n🌐 Mode: ${settings.mode}\n🤖 Chatbot: ${settings.chatbotGlobal ? 'ON' : 'OFF'}`);
                break;

            case 'owner':
                reply(`👑 Owner: ${settings.ownerId ? `<a href="tg://user?id=${settings.ownerId}">${settings.ownerId}</a>` : 'Not set'}`);
                break;

            // ========== OWNER CLAIM ==========
            case 'setowner':
                if (settings.ownerId) {
                    return reply('👑 An owner is already set.');
                }
                settings.ownerId = userId;
                reply('✅ You are now the bot owner. Use /menu to see all commands.');
                break;

            // ========== MODE TOGGLE ==========
            case 'mode':
                if (!isOwner) return reply('❌ Only owner can change mode.');
                if (input === 'public') {
                    settings.mode = 'public';
                } else if (input === 'private') {
                    settings.mode = 'private';
                } else {
                    return reply('Usage: /mode public|private');
                }
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
                reply(`🌐 <b>Translation:</b>\n${translated}`);
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
