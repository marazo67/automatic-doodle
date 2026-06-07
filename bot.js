// ======================== TARAGON TELEGRAM BOT ========================
// Run: node bot.js
// Install: npm install node-telegram-bot-api axios yt-search express
// Auto‑installs ffmpeg and yt-dlp on first run if missing
// ======================================================================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec, spawn, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ==================== AUTO‑INSTALL DEPENDENCIES ====================
async function ensureDependencies() {
    console.log('🔍 Checking for required system tools (ffmpeg, yt-dlp)...');

    const checkCmd = async (cmd) => {
        try {
            await execAsync(`command -v ${cmd}`);
            return true;
        } catch { return false; }
    };

    const hasFfmpeg = await checkCmd('ffmpeg');
    const hasYtDlp = await checkCmd('yt-dlp');

    if (hasFfmpeg && hasYtDlp) {
        console.log('✅ ffmpeg and yt-dlp are already installed.');
        return;
    }

    console.log('⚠️ Missing dependencies. Attempting to install...');

    // Try apt-get (Ubuntu/Debian)
    const aptGetInstalled = await (async () => {
        try {
            await execAsync('command -v apt-get');
            console.log('📦 Using apt-get to install ffmpeg and yt-dlp...');
            // Try without sudo first (if running as root), fallback to sudo
            await execAsync('apt-get update -qq && apt-get install -y -qq ffmpeg yt-dlp').catch(async () => {
                await execAsync('sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg yt-dlp');
            });
            return true;
        } catch (e) {
            console.log('apt-get installation failed:', e.message);
            return false;
        }
    })();

    // If apt-get failed, install static binaries
    if (!aptGetInstalled || (!await checkCmd('ffmpeg') || !await checkCmd('yt-dlp'))) {
        console.log('📥 Falling back to static binary downloads...');

        // Install ffmpeg static
        if (!await checkCmd('ffmpeg')) {
            console.log('Downloading ffmpeg static build...');
            await execAsync('wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz');
            await execAsync('tar xf ffmpeg-release-amd64-static.tar.xz');
            await execAsync('sudo cp ffmpeg-*-static/ffmpeg /usr/local/bin/');
            await execAsync('sudo cp ffmpeg-*-static/ffprobe /usr/local/bin/');
            await execAsync('rm -rf ffmpeg-*-static ffmpeg-release-amd64-static.tar.xz');
            console.log('✅ ffmpeg installed to /usr/local/bin');
        }

        // Install yt-dlp static
        if (!await checkCmd('yt-dlp')) {
            console.log('Downloading yt-dlp binary...');
            await execAsync('sudo wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp');
            await execAsync('sudo chmod a+rx /usr/local/bin/yt-dlp');
            console.log('✅ yt-dlp installed to /usr/local/bin');
        }
    }

    // Final verification
    const finalFfmpeg = await checkCmd('ffmpeg');
    const finalYtDlp = await checkCmd('yt-dlp');
    if (finalFfmpeg && finalYtDlp) {
        console.log('🎉 All dependencies ready!');
        const ffmpegVer = (await execAsync('ffmpeg -version | head -n1')).stdout.trim();
        const ytDlpVer = (await execAsync('yt-dlp --version')).stdout.trim();
        console.log(`📌 ffmpeg: ${ffmpegVer}`);
        console.log(`📌 yt-dlp: ${ytDlpVer}`);
    } else {
        console.warn('⚠️ Could not install dependencies automatically. Some download commands may fail.');
        if (!finalFfmpeg) console.warn('   Missing: ffmpeg');
        if (!finalYtDlp) console.warn('   Missing: yt-dlp');
    }
}

// ==================== RENDER PORT BINDING ====================
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Taragon Telegram Bot is alive! 🤖');
});
server.listen(PORT, () => {
    console.log(`✅ Keep-alive server running on port ${PORT}`);
});

// ==================== BOT TOKEN ====================
const TOKEN = process.env.BOT_TOKEN || '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E';
if (!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('❌ Please set your bot token as BOT_TOKEN env variable.');
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ==================== GLOBAL SETTINGS ====================
let settings = {
    mode: 'public',
    chatbotGlobal: true,
    funMode: true,
    ownerId: null,
    admins: [],
};
let startTime = Date.now();

const chatMemory = new Map();
const userInfo = new Map();

// ==================== AI APIs ====================
const ALL_AI_APIS = [
    { name: 'ZellAPI',      url: (q) => `https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`,                                          extract: (d) => d?.result },
    { name: 'Vapis Gemini', url: (q) => `https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`,                                               extract: (d) => d?.message },
    { name: 'Siputzx',      url: (q) => `https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`,                            extract: (d) => d?.data },
    { name: 'Ryzen',        url: (q) => `https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`,                                   extract: (d) => d?.answer },
    { name: 'GiftedPro',    url: (q) => `https://api.giftedtech.my.id/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(q)}`,                extract: (d) => d?.answer },
    { name: 'ZellBackup',   url: (q) => `https://zellapi.autos/ai/chatbot?text=${encodeURIComponent('Reply to: ' + q)}`,                           extract: (d) => d?.result },
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
    const fallbacks = ["Haan bhai! 😊", "Kya scene hai? 😎", "Hmm soch raha hu... 🤔", "Kya baat hai! 🔥", "Bhai tu legend hai! 👑"];
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

// ==================== HELPERS ====================
function formatCount(n) {
    if (!n || isNaN(n)) return 'N/A';
    n = parseInt(n);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toString();
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'N/A';
    const s = parseInt(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function buildMediaCaption({ title, artist, duration, views, likes, thumbnail, link, type = 'song' }) {
    const icon = type === 'video' ? '🎬' : '🎵';
    const lines = [];
    lines.push(`${icon} <b>${escapeHtml(title || 'Unknown')}</b>`);
    if (artist) lines.push(`👤 <b>Artist:</b> ${escapeHtml(artist)}`);
    if (duration) lines.push(`⏱ <b>Duration:</b> ${duration}`);
    if (views && views !== 'N/A') lines.push(`👁 <b>Views:</b> ${views}`);
    if (likes && likes !== 'N/A') lines.push(`❤️ <b>Likes:</b> ${likes}`);
    if (link) lines.push(`🔗 <a href="${link}">Open on YouTube</a>`);
    lines.push('\n🇻🇦 <i>Taragon Squad TRS</i>');
    return lines.join('\n');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ==================== DOWNLOAD HELPERS ====================
const AXIOS_DEFAULTS = { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };

const tryRequest = async (fn, attempts = 2) => {
    for (let i = 1; i <= attempts; i++) {
        try { return await fn(); }
        catch (err) { 
            if (i < attempts) await new Promise(r => setTimeout(r, 2000 * i)); 
            else throw err; 
        }
    }
};

const downloadBuffer = async (url) => {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    return response.data;
};

async function getYouTubeMeta(videoUrl) {
    try {
        const urlObj = new URL(videoUrl);
        const videoId = urlObj.searchParams.get('v') || urlObj.pathname.replace('/', '');
        const search = await yts({ videoId });
        if (search) {
            return {
                title: search.title,
                artist: search.author?.name,
                duration: search.timestamp,
                views: formatCount(search.views),
                likes: 'N/A',
                thumbnail: search.thumbnail,
                link: search.url,
            };
        }
    } catch (e) {}
    return {};
}

async function downloadSong(urlOrQuery) {
    const isUrl = /youtube\.com|youtu\.be/i.test(urlOrQuery);
    let video;

    if (isUrl) {
        video = { url: urlOrQuery, title: 'YouTube Audio' };
        const meta = await getYouTubeMeta(urlOrQuery);
        video = { ...video, ...meta };
    } else {
        const search = await yts(urlOrQuery);
        if (!search?.videos?.length) throw new Error('No results found for that song.');
        const v = search.videos[0];
        video = {
            url: v.url,
            title: v.title,
            artist: v.author?.name,
            duration: v.timestamp,
            views: formatCount(v.views),
            likes: 'N/A',
            thumbnail: v.thumbnail,
            link: v.url,
        };
    }

    const apis = [
        { name: 'Yupra', url: `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.data?.data?.download_url || d?.data?.download_url || d?.download_url },
        { name: 'Okatsu', url: `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.data?.dl || d?.data?.download_url || d?.dl },
        { name: 'Siputzx', url: `https://api.siputzx.my.id/api/download/ytmp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.data?.download_url || d?.download_url },
        { name: 'Vapis', url: `https://vapis.my.id/api/ytdl/mp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.result?.download_url || d?.download_url },
        { name: 'ZellAPI', url: `https://zellapi.autos/downloader/ytmp3?url=${encodeURIComponent(video.url)}`, extract: (d) => d?.result?.download_url || d?.download_url }
    ];

    for (const api of apis) {
        try {
            console.log(`Trying API: ${api.name} for ${video.url}`);
            const res = await tryRequest(() => axios.get(api.url, { ...AXIOS_DEFAULTS, timeout: 15000 }));
            const dlUrl = api.extract(res.data);
            if (dlUrl && (dlUrl.startsWith('http') || dlUrl.startsWith('//'))) {
                const fullUrl = dlUrl.startsWith('//') ? 'https:' + dlUrl : dlUrl;
                const buffer = await downloadBuffer(fullUrl);
                return { buffer, mime: 'audio/mpeg', ext: 'mp3', ...video };
            }
        } catch (err) {
            console.log(`API ${api.name} failed:`, err.message);
        }
    }

    console.log('All APIs failed, trying yt-dlp fallback...');
    try {
        await execAsync('yt-dlp --version');
        const buffer = await new Promise((resolve, reject) => {
            const args = ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', '-', video.url];
            const proc = spawn('yt-dlp', args);
            const chunks = [];
            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.stderr.on('data', data => console.log('yt-dlp stderr:', data.toString()));
            proc.on('close', (code) => {
                if (code === 0) resolve(Buffer.concat(chunks));
                else reject(new Error(`yt-dlp exited with code ${code}`));
            });
            proc.on('error', reject);
        });
        return { buffer, mime: 'audio/mpeg', ext: 'mp3', ...video };
    } catch (err) {
        if (err.message.includes('yt-dlp: command not found')) {
            throw new Error('yt-dlp is not installed. The bot attempted to auto-install it but failed. Please check logs.');
        }
        throw new Error(`All download methods failed. Last error: ${err.message}`);
    }
}

async function downloadVideo(url) {
    let meta = {};
    try { meta = await getYouTubeMeta(url); } catch(e) {}

    const apis = [
        { name: 'Yupra Video', url: `https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(url)}`, extract: (d) => d?.data?.data?.download_url || d?.data?.download_url },
        { name: 'Okatsu Video', url: `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(url)}`, extract: (d) => d?.data?.mp4 || d?.data?.result?.mp4 || d?.result?.mp4 },
        { name: 'Siputzx Video', url: `https://api.siputzx.my.id/api/download/ytmp4?url=${encodeURIComponent(url)}`, extract: (d) => d?.data?.download_url || d?.download_url }
    ];

    for (const api of apis) {
        try {
            console.log(`Trying video API: ${api.name}`);
            const res = await tryRequest(() => axios.get(api.url, AXIOS_DEFAULTS));
            const dlUrl = api.extract(res.data);
            if (dlUrl && dlUrl.startsWith('http')) {
                const buffer = await downloadBuffer(dlUrl);
                return { buffer, title: meta.title || 'Video', ...meta };
            }
        } catch (err) {
            console.log(`Video API ${api.name} failed:`, err.message);
        }
    }

    try {
        await execAsync('yt-dlp --version');
        const buffer = await new Promise((resolve, reject) => {
            const args = ['-f', 'best[ext=mp4][filesize<50M]', '-o', '-', url];
            const proc = spawn('yt-dlp', args);
            const chunks = [];
            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.stderr.on('data', data => console.log('yt-dlp video stderr:', data.toString()));
            proc.on('close', (code) => {
                if (code === 0) resolve(Buffer.concat(chunks));
                else reject(new Error(`yt-dlp video exited with ${code}`));
            });
        });
        return { buffer, title: meta.title || 'Video', ...meta };
    } catch (err) {
        throw new Error(`Video download failed: ${err.message}`);
    }
}

async function downloadTikTok(url) {
    const res = await tryRequest(() =>
        axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, { timeout: 15000 })
    );
    if (res?.data?.data) {
        const d = res.data.data;
        const u = d.urls?.[0] || d.video_url || d.url || d.download_url;
        if (u) return {
            videoUrl: u,
            title: d.metadata?.title || 'TikTok Video',
            artist: d.metadata?.author || '',
            views: formatCount(d.metadata?.play_count),
            likes: formatCount(d.metadata?.digg_count),
            duration: d.metadata?.duration ? formatDuration(d.metadata.duration) : 'N/A',
            link: url,
        };
    }
    throw new Error('Failed to download TikTok.');
}

async function translate(text, targetLang) {
    try {
        const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`);
        return res.data[0][0][0];
    } catch { return text; }
}

// ==================== MESSAGE HANDLER ====================
bot.on('message', async (msg) => {
    if (!msg.text && !msg.caption) return;
    const text = (msg.text || msg.caption).trim();
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    const isOwner = userId === settings.ownerId;
    const isAdmin = settings.admins.includes(userId) || isOwner;

    if (settings.mode === 'private' && !isOwner && text.startsWith('/')) {
        if (!text.startsWith('/start') && !text.startsWith('/help') && !text.startsWith('/menu')) {
            return bot.sendMessage(chatId, '🔒 Bot is in private mode. Only the owner can use commands.');
        }
    }

    if (!text.startsWith('/') && !isGroup) {
        const msgs = chatMemory.get(userId) || [];
        msgs.push(text);
        if (msgs.length > 20) msgs.shift();
        chatMemory.set(userId, msgs);
    }

    if (settings.chatbotGlobal && !text.startsWith('/') && !isGroup) {
        const funReply = settings.funMode ? getFunReply(text) : null;
        if (funReply) return bot.sendMessage(chatId, funReply);
        const reply = await getAIResponse(text, userId);
        return bot.sendMessage(chatId, reply);
    }

    if (isGroup && !text.startsWith('/') && settings.chatbotGlobal && msg.entities) {
        const botInfo = await bot.getMe();
        const mentioned = msg.entities.some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length) === `@${botInfo.username}`);
        if (mentioned) {
            const cleanText = text.replace(`@${botInfo.username}`, '').trim();
            if (cleanText) {
                const reply = await getAIResponse(cleanText, userId);
                return bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
            }
        }
    }

    if (!text.startsWith('/')) return;

    const args = text.slice(1).split(' ');
    const command = args.shift().toLowerCase().split('@')[0];
    const input = args.join(' ').trim();

    const reply = (msgText, extra = {}) =>
        bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', reply_to_message_id: msg.message_id, ...extra });

    try {
        switch (command) {
            case 'start':
                return bot.sendMessage(chatId,
                    `🇻🇦 <b>TARAGON SQUAD TRS</b> — Telegram Bot\n\n` +
                    `Send any message to chat with AI.\n` +
                    `Use <b>/menu</b> to see all commands.\n\n` +
                    `👑 Owner: ${settings.ownerId ? 'Set ✅' : 'Not set — use /setowner to claim.'}`,
                    { parse_mode: 'HTML' }
                );

            case 'menu':
            case 'help':
                return reply(
                    `╭━━━❰ <b>TARAGON BOT</b> ❱━━━╮\n` +
                    `┃ ⚡ Mode: ${settings.mode}  |  Uptime: ${formatUptime()}\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
                    `<b>🌐 GENERAL</b>\n  /ping  /alive  /menu\n\n` +
                    `<b>🤖 AI</b>\n  /gpt &lt;question&gt;\n  /gemini &lt;question&gt;\n  /imagine &lt;prompt&gt;\n\n` +
                    `<b>📥 DOWNLOADERS</b>\n  /play &lt;song/url&gt;\n  /ytmp3 &lt;url&gt;\n  /ytmp4 &lt;url&gt;\n  /tiktok &lt;url&gt;\n  /spotify &lt;song&gt;\n  /instagram &lt;url&gt;\n  /facebook &lt;url&gt;\n\n` +
                    `<b>🛠 UTILITIES</b>\n  /trt &lt;text&gt; &lt;lang&gt;\n  /check &lt;host&gt;\n\n` +
                    `<b>🔒 OWNER</b>\n  /setowner  /mode  /chatbot  /funmode  /shutdown`
                );

            case 'ping': {
                const t0 = Date.now();
                const sent = await bot.sendMessage(chatId, '🏓 Pinging...');
                bot.editMessageText(`🏓 Pong! ${Date.now() - t0}ms`, { chat_id: chatId, message_id: sent.message_id });
                break;
            }

            case 'alive':
                reply(
                    `✅ <b>TARAGON BOT</b> is alive!\n` +
                    `⏰ Uptime: ${formatUptime()}\n` +
                    `🌐 Mode: ${settings.mode}\n` +
                    `🤖 Chatbot: ${settings.chatbotGlobal ? 'ON ✅' : 'OFF ❌'}\n` +
                    `🎉 Fun Mode: ${settings.funMode ? 'ON ✅' : 'OFF ❌'}`
                );
                break;

            case 'owner':
                reply(`👑 Owner: ${settings.ownerId ? `<a href="tg://user?id=${settings.ownerId}">${settings.ownerId}</a>` : 'Not set'}`);
                break;

            case 'setowner':
                if (settings.ownerId) return reply('👑 Owner is already set.');
                settings.ownerId = userId;
                reply(`✅ <b>You are now the bot owner!</b>\nUse /menu to see all commands.`);
                break;

            case 'mode':
                if (!isOwner) return reply('❌ Only owner can change mode.');
                if (input === 'public') settings.mode = 'public';
                else if (input === 'private') settings.mode = 'private';
                else return reply('Usage: /mode public|private');
                reply(`🌐 Mode set to: <b>${settings.mode}</b>`);
                break;

            case 'chatbot':
                if (!isOwner) return reply('❌ Owner only.');
                if (input === 'on') settings.chatbotGlobal = true;
                else if (input === 'off') settings.chatbotGlobal = false;
                else return reply('Usage: /chatbot on|off');
                reply(`🤖 Global chatbot: <b>${settings.chatbotGlobal ? 'ON ✅' : 'OFF ❌'}</b>`);
                break;

            case 'funmode':
                if (!isOwner) return reply('❌ Owner only.');
                if (input === 'on') settings.funMode = true;
                else if (input === 'off') settings.funMode = false;
                else return reply('Usage: /funmode on|off');
                reply(`🎉 Fun mode: <b>${settings.funMode ? 'ON ✅' : 'OFF ❌'}</b>`);
                break;

            case 'shutdown':
                if (!isOwner) return reply('❌ Owner only.');
                await reply('🛑 Shutting down...');
                process.exit(0);

            case 'gpt':
            case 'gemini':
                if (!input) return reply(`Usage: /${command} &lt;question&gt;`);
                {
                    const aiReply = await getAIResponse(input, userId);
                    reply(`🤖 ${aiReply}`);
                }
                break;

            case 'imagine':
                if (!input) return reply('Usage: /imagine &lt;prompt&gt;');
                try {
                    const { data } = await axios.get(`https://api.siputzx.my.id/api/ai/stablediffusion?prompt=${encodeURIComponent(input)}`);
                    const imgUrl = typeof data === 'string' ? data : data?.url || data?.image;
                    if (imgUrl) {
                        const buffer = await downloadBuffer(imgUrl);
                        await bot.sendPhoto(chatId, buffer, {
                            caption: `🎨 <b>${escapeHtml(input)}</b>\n\n🇻🇦 <i>Taragon Squad TRS</i>`,
                            parse_mode: 'HTML',
                            reply_to_message_id: msg.message_id
                        });
                    } else throw new Error();
                } catch {
                    reply('❌ Image generation failed. Try a different prompt.');
                }
                break;

            case 'play':
            case 'ytmp3': {
                if (!input) return reply('Usage: /play &lt;song name or YouTube URL&gt;');
                const statusMsg = await reply('⏳ Searching and downloading audio... (this may take up to 30s)');
                try {
                    const result = await downloadSong(input);
                    const caption = buildMediaCaption({
                        title: result.title,
                        artist: result.artist,
                        duration: result.duration,
                        views: result.views,
                        likes: result.likes,
                        link: result.link,
                        type: 'song',
                    });

                    if (result.thumbnail) {
                        try {
                            await bot.sendPhoto(chatId, result.thumbnail, {
                                caption,
                                parse_mode: 'HTML',
                                reply_to_message_id: msg.message_id,
                            });
                        } catch (thumbErr) { console.log('Thumbnail error:', thumbErr.message); }
                    } else {
                        await bot.editMessageText(caption, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
                    }

                    await bot.sendAudio(chatId, result.buffer, {
                        title: result.title || 'Audio',
                        performer: result.artist || 'Taragon',
                        filename: `${result.title || 'audio'}.mp3`,
                        caption: `🎵 <b>${escapeHtml(result.title || 'Audio')}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                        parse_mode: 'HTML',
                    });
                    bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
                } catch (e) {
                    reply(`❌ ${e.message}`);
                }
                break;
            }

            case 'ytmp4': {
                if (!input) return reply('Usage: /ytmp4 &lt;YouTube URL&gt;');
                await reply('⏳ Downloading video...');
                try {
                    const result = await downloadVideo(input);
                    const caption = buildMediaCaption({
                        title: result.title,
                        artist: result.artist,
                        duration: result.duration,
                        views: result.views,
                        likes: result.likes,
                        link: result.link || input,
                        type: 'video',
                    });
                    await bot.sendVideo(chatId, result.buffer, {
                        caption,
                        parse_mode: 'HTML',
                        reply_to_message_id: msg.message_id,
                    });
                } catch (e) {
                    reply(`❌ ${e.message}`);
                }
                break;
            }

            case 'tiktok': {
                if (!input) return reply('Usage: /tiktok &lt;TikTok URL&gt;');
                await reply('⏳ Downloading TikTok...');
                try {
                    const result = await downloadTikTok(input);
                    const caption = buildMediaCaption({
                        title: result.title,
                        artist: result.artist,
                        duration: result.duration,
                        views: result.views,
                        likes: result.likes,
                        link: result.link,
                        type: 'video',
                    });
                    const buffer = await downloadBuffer(result.videoUrl);
                    await bot.sendVideo(chatId, buffer, {
                        caption,
                        parse_mode: 'HTML',
                        reply_to_message_id: msg.message_id,
                    });
                } catch (e) {
                    reply(`❌ ${e.message}`);
                }
                break;
            }

            case 'spotify': {
                if (!input) return reply('Usage: /spotify &lt;song name&gt;');
                await reply('⏳ Searching Spotify...');
                try {
                    const { data } = await axios.get(
                        `https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(input)}`,
                        { timeout: 20000 }
                    );
                    if (data?.status && data?.result?.audio) {
                        const r = data.result;
                        const caption = buildMediaCaption({
                            title: r.title,
                            artist: r.artist,
                            duration: r.duration ? formatDuration(r.duration) : 'N/A',
                            views: 'N/A',
                            likes: 'N/A',
                            type: 'song',
                        });

                        if (r.thumbnails) {
                            try {
                                await bot.sendPhoto(chatId, r.thumbnails, { caption, parse_mode: 'HTML', reply_to_message_id: msg.message_id });
                            } catch {}
                        }

                        const audioBuffer = await downloadBuffer(r.audio);
                        await bot.sendAudio(chatId, audioBuffer, {
                            title: r.title,
                            performer: r.artist,
                            filename: `${r.title}.mp3`,
                            caption: `🎵 <b>${escapeHtml(r.title || 'Audio')}</b>\n🇻🇦 <i>Taragon Squad TRS</i>`,
                            parse_mode: 'HTML',
                        });
                    } else throw new Error('No audio found');
                } catch {
                    reply('❌ Spotify download failed. Try a different song name.');
                }
                break;
            }

            case 'instagram': {
                if (!input) return reply('Usage: /instagram &lt;Instagram URL&gt;');
                await reply('⏳ Downloading Instagram...');
                try {
                    const { data } = await axios.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(input)}`);
                    if (data?.data?.url) {
                        const buffer = await downloadBuffer(data.data.url);
                        await bot.sendVideo(chatId, buffer, {
                            caption: `📸 <b>Instagram</b>\n🔗 <a href="${input}">View Original</a>\n\n🇻🇦 <i>Taragon Squad TRS</i>`,
                            parse_mode: 'HTML',
                            reply_to_message_id: msg.message_id,
                        });
                    } else throw new Error();
                } catch {
                    reply('❌ Instagram download failed.');
                }
                break;
            }

            case 'facebook': {
                if (!input) return reply('Usage: /facebook &lt;Facebook video URL&gt;');
                await reply('⏳ Downloading Facebook video...');
                try {
                    const { data } = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(input)}`);
                    if (data?.data?.url) {
                        const buffer = await downloadBuffer(data.data.url);
                        await bot.sendVideo(chatId, buffer, {
                            caption: `📘 <b>Facebook Video</b>\n🔗 <a href="${input}">View Original</a>\n\n🇻🇦 <i>Taragon Squad TRS</i>`,
                            parse_mode: 'HTML',
                            reply_to_message_id: msg.message_id,
                        });
                    } else throw new Error();
                } catch {
                    reply('❌ Facebook download failed.');
                }
                break;
            }

            case 'trt': {
                const parts = input.split(' ');
                const lang = parts.pop();
                const toTranslate = parts.join(' ');
                if (!toTranslate || !lang) return reply('Usage: /trt &lt;text&gt; &lt;lang_code&gt;\nExample: /trt Hello World es');
                const translated = await translate(toTranslate, lang);
                reply(`🌐 <b>Translation (→${lang}):</b>\n${escapeHtml(translated)}`);
                break;
            }

            case 'check': {
                if (!input) return reply('Usage: /check &lt;host&gt;');
                const host = input.trim();
                await reply(`🔍 Checking <code>${escapeHtml(host)}</code>...`);
                try {
                    const { stdout } = await execAsync(`nmap -p 80,443,8080 ${host}`, { timeout: 30000 });
                    reply(`📡 <b>nmap:</b>\n<pre>${escapeHtml(stdout.trim().substring(0, 2000))}</pre>`);
                } catch (e) {
                    reply(`❌ nmap: ${escapeHtml(e.message)}`);
                }
                try {
                    const { stdout } = await execAsync(`curl -I -s --max-time 10 "${host}"`, { timeout: 15000 });
                    reply(`🌐 <b>curl:</b>\n<pre>${escapeHtml(stdout.trim().substring(0, 2000))}</pre>`);
                } catch (e) {
                    reply(`❌ curl: ${escapeHtml(e.message)}`);
                }
                break;
            }

            default:
                reply('❓ Unknown command. Type /menu for help.');
        }
    } catch (err) {
        console.error('Command error:', err);
        reply('⚠️ Something went wrong. Please try again later.');
    }
});

bot.on('polling_error', (err) => {
    console.error('Polling error:', err.message);
});

function formatUptime() {
    const u = Date.now() - startTime;
    const h = Math.floor(u / 3600000);
    const m = Math.floor((u % 3600000) / 60000);
    const s = Math.floor((u % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
}

// ==================== START BOT WITH DEPENDENCY CHECK ====================
(async () => {
    await ensureDependencies();
    console.log('🤖 Taragon Telegram Bot started (AUTO‑INSTALL ENABLED)!');
    console.log(`🌐 Keep-alive server on port ${PORT}`);
    console.log('📩 Send /start to begin.');
})();
