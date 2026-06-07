// ======================== TARAGON TELEGRAM BOT + WA PAIRING ========================
// Features: AI, downloaders, utilities, WhatsApp pairing (code & QR), session ID generation.
// Owner only commands: /pair, /qr, /logout, /status, /settings, /cleartmp
// ===================================================================================

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
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
const crypto = require('crypto');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ========================= CONFIG =========================
const TELEGRAM_TOKEN = '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E'; // @BotFather
const OWNER_ID = 7784215573; // Your Telegram user ID (hardcoded owner)
const PORT = process.env.PORT || 3000;
// ==========================================================

// ── Directories ──────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, 'auth_main');
const TEMP_DIR = path.join(__dirname, 'temp');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

[path.join(__dirname, 'public'), TEMP_DIR, AUTH_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Global settings ──────────────────────────────────────
let settings = {};
if (fs.existsSync(SETTINGS_FILE)) settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));

const defaultSettings = {
    mode: 'public',        // not used, everything public
    autoDownload: true,    // auto‑download /play etc.
    allowedUsers: [],      // if not empty, only these IDs can use commands
};
Object.entries(defaultSettings).forEach(([k, v]) => {
    if (settings[k] === undefined) settings[k] = v;
});
function saveSettings() { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

// ── WhatsApp state ───────────────────────────────────────
let whatsAppSocket = null;
let botNumber = null;
let sessionId = null; // generated after pairing

// ── Helpers ──────────────────────────────────────────────
const downloadBuffer = async (url) => (await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 })).data;

async function generateSessionId(authDir) {
    const credsPath = path.join(authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    const raw = fs.readFileSync(credsPath, 'utf8').substring(0, 64);
    const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    return `TRS-${hash.substring(0, 15)}`;
}

// ── AI ───────────────────────────────────────────────────
const ALL_AI_APIS = [
    { name:'ZellAPI', url:(q)=>`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`, extract:(d)=>d?.result },
    { name:'Vapis Gemini', url:(q)=>`https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`, extract:(d)=>d?.message },
    { name:'Siputzx', url:(q)=>`https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`, extract:(d)=>d?.data },
    { name:'Ryzen', url:(q)=>`https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`, extract:(d)=>d?.answer },
    { name:'GiftedPro', url:(q)=>`https://api.giftedtech.my.id/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(q)}`, extract:(d)=>d?.answer },
];
async function getAIResponse(userMessage) {
    const prompt = `You're Scottie Kiidrsa, a real person. Reply in 1-2 lines max. Use Hinglish naturally. Be savage if abused, sweet if treated well. NEVER say you're AI. Message: ${userMessage}`;
    const promises = ALL_AI_APIS.map(async (a) => {
        try {
            const res = await axios.get(a.url(prompt), { timeout: 8000 });
            const answer = a.extract(res.data);
            if (answer && typeof answer === 'string' && answer.length > 2) return answer.trim();
        } catch {}
        return null;
    });
    const results = await Promise.allSettled(promises);
    for (const r of results) if (r.status === 'fulfilled' && r.value) return r.value;
    return "Haan bhai! 😊";
}

// ── Downloader helpers ───────────────────────────────────
async function searchYouTube(query) {
    const search = await yts(query);
    if (!search?.videos?.length) throw new Error('No results');
    return search.videos[0]; // returns { title, url, timestamp, views, image (thumbnail) }
}

async function downloadAudio(videoUrl) {
    const apis = [
        { url: `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(videoUrl)}&format=mp3`, extract: d => d?.data?.downloadURL },
        { url: `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}`, extract: d => d?.data?.data?.download_url },
    ];
    for (const a of apis) {
        try {
            const res = await axios.get(a.url, { timeout: 30000 });
            const url = a.extract(res);
            if (url) return downloadBuffer(url);
        } catch {}
    }
    // fallback yt-dlp
    const out = path.join(TEMP_DIR, `audio_${Date.now()}.mp3`);
    await execAsync(`yt-dlp -x --audio-format mp3 -o "${out}" "${videoUrl}"`, { timeout: 120000 });
    if (fs.existsSync(out)) {
        const buffer = fs.readFileSync(out);
        fs.unlinkSync(out);
        return buffer;
    }
    throw new Error('Download failed');
}

// ======================== TELEGRAM BOT ============================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Middleware: block non‑owner from owner commands
const ownerOnly = (msg, next) => {
    if (msg.from.id === OWNER_ID) return next();
    bot.sendMessage(msg.chat.id, '❌ This command is only for the bot owner.');
};

// ── Commands ──────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const status = whatsAppSocket ? `✅ WhatsApp connected as +${botNumber}\nSession ID: <code>${sessionId}</code>` : '⚠️ WhatsApp not paired. Use /pair or /qr.';
    await bot.sendMessage(chatId, `🇻🇦 <b>TARAGON SQUAD TRS</b> – Telegram Bot\n\n${status}\n\n<b>Public commands:</b>\n/play <song>  /ytmp4 <url>  /tiktok <url>  /spotify <song>\n/instagram <url>  /facebook <url>\n/gpt <query>  /imagine <prompt>\n/trt <text> <lang>  /check <host>\n\n<b>Owner only:</b>\n/pair <phone>  /qr  /logout  /status`, { parse_mode: 'HTML' });
});

bot.onText(/\/status/, (msg) => {
    if (msg.from.id !== OWNER_ID) return ownerOnly(msg, ()=>null);
    const chatId = msg.chat.id;
    if (whatsAppSocket) {
        bot.sendMessage(chatId, `✅ Connected as +${botNumber}\nSession ID: <code>${sessionId}</code>`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(chatId, '❌ Not connected.');
    }
});

bot.onText(/\/logout/, (msg) => {
    if (msg.from.id !== OWNER_ID) return ownerOnly(msg, ()=>null);
    const chatId = msg.chat.id;
    if (!whatsAppSocket) return bot.sendMessage(chatId, '⚠️ No active connection.');
    whatsAppSocket.end();
    whatsAppSocket = null;
    botNumber = null;
    sessionId = null;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    bot.sendMessage(chatId, '🛑 Disconnected and session cleared.');
});

// Pairing: code method
bot.onText(/\/pair(?: (.+))?/, (msg, match) => {
    if (msg.from.id !== OWNER_ID) return ownerOnly(msg, ()=>null);
    const chatId = msg.chat.id;
    const phone = match[1]?.replace(/\D/g, '');
    if (!phone || phone.length < 10) return bot.sendMessage(chatId, 'Usage: /pair 1234567890');
    startPairing(chatId, phone, 'code');
});

// Pairing: QR method
bot.onText(/\/qr/, (msg) => {
    if (msg.from.id !== OWNER_ID) return ownerOnly(msg, ()=>null);
    startPairing(msg.chat.id, null, 'qr');
});

// ── Public commands ──────────────────────────────────────
bot.onText(/\/play(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];
    if (!query) return bot.sendMessage(chatId, 'Usage: /play <song name or YouTube URL>');
    const isUrl = /youtube\.com|youtu\.be/.test(query);
    try {
        await bot.sendChatAction(chatId, 'typing');
        let video;
        if (isUrl) {
            // For a direct URL we can't get full metadata easily without an API, but we can try yt-dlp to get info
            video = { url: query, title: 'Unknown', timestamp: '', views: '', image: '' };
        } else {
            video = await searchYouTube(query);
        }
        const { title, url, timestamp, views, image } = video;

        // Send metadata card
        const caption = `<b>🎵 ${title}</b>\n` +
            (timestamp ? `⏱ Duration: ${timestamp}\n` : '') +
            (views ? `👁 Views: ${views}\n` : '') +
            `🔗 <a href="${url}">YouTube</a>`;

        if (image) {
            await bot.sendPhoto(chatId, image, { caption, parse_mode: 'HTML' });
        } else {
            await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
        }

        // Download and send audio
        await bot.sendChatAction(chatId, 'upload_voice');
        const audioBuffer = await downloadAudio(url);
        await bot.sendAudio(chatId, audioBuffer, {
            title,
            performer: 'YouTube Audio',
            fileName: `${title}.mp3`,
            caption: `🎧 ${title}`
        });
    } catch (e) {
        bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
});

bot.onText(/\/ytmp4(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    if (!url) return bot.sendMessage(chatId, 'Usage: /ytmp4 <YouTube URL>');
    try {
        await bot.sendChatAction(chatId, 'upload_video');
        // use yt-dlp
        const out = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
        await execAsync(`yt-dlp -f "best[ext=mp4]" -o "${out}" "${url}"`, { timeout: 300000 });
        if (!fs.existsSync(out)) throw new Error('Download failed');
        const buffer = fs.readFileSync(out);
        fs.unlinkSync(out);
        await bot.sendVideo(chatId, buffer, { caption: '📹 Downloaded video' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ ${e.message}`);
    }
});

bot.onText(/\/tiktok(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    if (!url) return bot.sendMessage(chatId, 'Usage: /tiktok <URL>');
    try {
        await bot.sendChatAction(chatId, 'upload_video');
        const { data } = await axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, { timeout: 15000 });
        const d = data?.data;
        const videoUrl = d?.urls?.[0] || d?.video_url || d?.url;
        if (!videoUrl) throw new Error('No video found');
        const buffer = await downloadBuffer(videoUrl);
        await bot.sendVideo(chatId, buffer, { caption: d?.metadata?.title || 'TikTok' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ ${e.message}`);
    }
});

bot.onText(/\/spotify(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];
    if (!query) return bot.sendMessage(chatId, 'Usage: /spotify <song>');
    try {
        await bot.sendChatAction(chatId, 'typing');
        const { data } = await axios.get(`https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(query)}`, { timeout: 20000 });
        if (!data?.status || !data?.result?.audio) throw new Error('No audio');
        const r = data.result;
        const caption = `🎵 ${r.title}\n👤 ${r.artist || ''}`;
        if (r.thumbnails) await bot.sendPhoto(chatId, r.thumbnails, { caption });
        const buffer = await downloadBuffer(r.audio);
        await bot.sendAudio(chatId, buffer, { title: r.title, performer: r.artist, fileName: `${r.title}.mp3` });
    } catch (e) {
        bot.sendMessage(chatId, `❌ ${e.message}`);
    }
});

bot.onText(/\/instagram(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    if (!url) return bot.sendMessage(chatId, 'Usage: /instagram <URL>');
    try {
        await bot.sendChatAction(chatId, 'upload_video');
        const { data } = await axios.get(`https://api.siputzx.my.id/api/d/instagram?url=${encodeURIComponent(url)}`);
        if (data?.data?.url) {
            const buffer = await downloadBuffer(data.data.url);
            await bot.sendVideo(chatId, buffer);
        } else throw new Error('No media');
    } catch (e) {
        bot.sendMessage(chatId, `❌ ${e.message}`);
    }
});

bot.onText(/\/facebook(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match[1];
    if (!url) return bot.sendMessage(chatId, 'Usage: /facebook <URL>');
    try {
        await bot.sendChatAction(chatId, 'upload_video');
        const { data } = await axios.get(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`);
        if (data?.data?.url) {
            const buffer = await downloadBuffer(data.data.url);
            await bot.sendVideo(chatId, buffer);
        } else throw new Error('No video');
    } catch (e) {
        bot.sendMessage(chatId, `❌ ${e.message}`);
    }
});

bot.onText(/\/gpt(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];
    if (!query) return bot.sendMessage(chatId, 'Usage: /gpt <question>');
    await bot.sendChatAction(chatId, 'typing');
    const reply = await getAIResponse(query);
    bot.sendMessage(chatId, `🤖 ${reply}`);
});

bot.onText(/\/imagine(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const prompt = match[1];
    if (!prompt) return bot.sendMessage(chatId, 'Usage: /imagine <prompt>');
    try {
        await bot.sendChatAction(chatId, 'upload_photo');
        const { data } = await axios.get(`https://api.siputzx.my.id/api/ai/stablediffusion?prompt=${encodeURIComponent(prompt)}`);
        const url = typeof data === 'string' ? data : data?.url || data?.image;
        if (!url) throw new Error('No image');
        const buffer = await downloadBuffer(url);
        await bot.sendPhoto(chatId, buffer, { caption: prompt });
    } catch (e) {
        bot.sendMessage(chatId, '❌ Image generation failed.');
    }
});

bot.onText(/\/trt(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const args = match[1]?.split(' ');
    if (!args || args.length < 2) return bot.sendMessage(chatId, 'Usage: /trt <text> <lang_code>');
    const lang = args.pop();
    const text = args.join(' ');
    try {
        const res = await axios.get(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`);
        const translated = res.data[0][0][0];
        bot.sendMessage(chatId, `🌐 <b>Translation:</b>\n${translated}`, { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(chatId, '❌ Translation failed.');
    }
});

bot.onText(/\/check(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const host = match[1];
    if (!host) return bot.sendMessage(chatId, 'Usage: /check <host>');
    try {
        const { stdout } = await execAsync(`curl -I -s "${host}"`, { timeout: 10000 });
        bot.sendMessage(chatId, `<pre>${stdout.substring(0, 3000)}</pre>`, { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ curl error: ${e.message}`);
    }
});

// ==================== WHATSAPP PAIRING LOGIC ====================
let pairingInProgress = false;
let currentPairingSocket = null;

async function startPairing(chatId, phone, method) {
    if (pairingInProgress) return bot.sendMessage(chatId, '⏳ Another pairing is in progress.');
    pairingInProgress = true;

    // Clean previous auth if any
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
        currentPairingSocket = sock;

        if (method === 'code') {
            const code = await sock.requestPairingCode(phone);
            await bot.sendMessage(chatId, `<b>📲 Pairing Code</b>\n<code>${code}</code>\n\n1. Open WhatsApp → Linked Devices\n2. Tap Link a Device\n3. Enter the code above\n\nTimeout 3 minutes.`, { parse_mode: 'HTML' });
        } else if (method === 'qr') {
            // QR will be received via connection.update
        }

        let connected = false;
        let timedOut = false;
        const timeout = setTimeout(async () => {
            if (!connected) {
                timedOut = true;
                pairingInProgress = false;
                await bot.sendMessage(chatId, '⏰ Pairing timed out.');
                sock.end();
                currentPairingSocket = null;
            }
        }, 180_000);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;
            if (timedOut || connected) return;

            if (method === 'qr' && qr && !connected) {
                try {
                    const qrImage = await QRCode.toBuffer(qr, { scale: 8 });
                    await bot.sendPhoto(chatId, qrImage, { caption: '📷 Scan this QR with WhatsApp (Linked Devices)\nValid for 2 minutes.' });
                } catch (e) {
                    await bot.sendMessage(chatId, '❌ Failed to generate QR image.');
                    pairingInProgress = false;
                    sock.end();
                    currentPairingSocket = null;
                    clearTimeout(timeout);
                }
            }

            if (connection === 'open') {
                connected = true;
                clearTimeout(timeout);
                pairingInProgress = false;
                currentPairingSocket = null;

                const num = sock.user.id.split(':')[0];
                whatsAppSocket = sock;
                botNumber = num;
                sessionId = await generateSessionId(AUTH_DIR);

                await bot.sendMessage(chatId, `✅ Connected as +${num}\n<b>Session ID:</b> <code>${sessionId}</code>\n\nThis ID can be used to reconnect or for your WhatsApp bot.`, { parse_mode: 'HTML' });
            } else if (connection === 'close' && !connected) {
                clearTimeout(timeout);
                pairingInProgress = false;
                await bot.sendMessage(chatId, '❌ Connection closed unexpectedly.');
                sock.end();
                currentPairingSocket = null;
            }
        });

    } catch (err) {
        pairingInProgress = false;
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
}

// ==================== WEB SERVER & PANEL ====================
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: !!whatsAppSocket, sessionId }));

// ── Web panel HTML (same beautiful design, with session ID display) ──
const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TARAGON SQUAD TRS – Web Pairing</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:      #060810;
    --surface: #0d1117;
    --border:  rgba(255,255,255,0.06);
    --accent:  #5865f2;
    --accent2: #eb459e;
    --green:   #3ba55d;
    --red:     #ed4245;
    --text:    #e3e5e8;
    --muted:   #72767d;
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Syne',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;overflow-x:hidden}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;z-index:0;pointer-events:none}
  .blob{position:fixed;border-radius:50%;filter:blur(120px);opacity:.18;pointer-events:none;z-index:0}
  .b1{width:500px;height:500px;background:var(--accent);top:-100px;left:-100px;animation:drift1 12s ease-in-out infinite alternate}
  .b2{width:400px;height:400px;background:var(--accent2);bottom:-80px;right:-80px;animation:drift2 10s ease-in-out infinite alternate}
  @keyframes drift1{to{transform:translate(60px,80px)}}
  @keyframes drift2{to{transform:translate(-60px,-60px)}}
  .card{position:relative;z-index:10;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:40px 36px;width:100%;max-width:480px;box-shadow:0 0 60px rgba(88,101,242,.15)}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:4px}
  .logo-flag{font-size:36px}
  .logo-text{font-size:22px;font-weight:800;letter-spacing:-0.5px;background:linear-gradient(135deg,#fff 0%,#a5b4fc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .tagline{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-bottom:32px;letter-spacing:1px;text-transform:uppercase}
  .session-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(88,101,242,.12);border:1px solid rgba(88,101,242,.3);border-radius:8px;padding:8px 14px;margin-bottom:28px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#a5b4fc}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);animation:blink 2s infinite}
  @keyframes blink{50%{opacity:.3}}
  .input-wrap{position:relative;margin-bottom:14px}
  .input-wrap .icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;pointer-events:none}
  input{width:100%;padding:14px 14px 14px 44px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;color:var(--text);font-family:'Syne',sans-serif;font-size:15px;outline:none;transition:.2s}
  input:focus{border-color:var(--accent);background:rgba(88,101,242,.07)}
  input::placeholder{color:var(--muted)}
  .btn{width:100%;padding:15px;border:none;border-radius:12px;font-family:'Syne',sans-serif;font-size:15px;font-weight:700;cursor:pointer;transition:.25s;letter-spacing:.3px}
  .btn-main{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;box-shadow:0 4px 24px rgba(88,101,242,.4)}
  .btn-main:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 32px rgba(88,101,242,.6)}
  .btn-main:disabled{opacity:.45;cursor:not-allowed;transform:none}
  .result{margin-top:24px;display:none}
  .result.show{display:block;animation:fadeUp .35s ease}
  @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}}
  .code-box{background:#0a0c10;border:2px dashed rgba(88,101,242,.4);border-radius:14px;padding:24px;text-align:center;margin:14px 0}
  .code-val{font-family:'JetBrains Mono',monospace;font-size:40px;font-weight:600;letter-spacing:12px;color:var(--accent);text-shadow:0 0 24px rgba(88,101,242,.6);user-select:all}
  .steps{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-top:14px}
  .step{display:flex;align-items:flex-start;gap:10px;padding:5px 0;font-size:13px;color:rgba(255,255,255,.65)}
  .sn{min-width:20px;height:20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;margin-top:1px}
  .status-msg{text-align:center;font-size:13px;margin-top:14px;min-height:20px}
  .ok{color:var(--green)} .err{color:var(--red)}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite;vertical-align:middle;margin-right:8px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .footer{margin-top:28px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted)}
  .footer a{color:var(--accent);text-decoration:none}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div class="card">
  <div class="logo"><span class="logo-flag">🇻🇦</span><span class="logo-text">TARAGON SQUAD TRS</span></div>
  <div class="tagline">WhatsApp Pairing</div>
  <div class="session-badge"><span class="dot"></span><span id="session-display">Not connected</span></div>
  <div class="input-wrap"><span class="icon">📱</span><input type="tel" id="phone" placeholder="Phone (e.g. 1234567890)" maxlength="15"></div>
  <button class="btn btn-main" id="pairBtn" onclick="requestCode()"><span id="btnText">🔗 Generate Pairing Code</span></button>
  <div class="result" id="result">
    <div class="code-box"><div class="code-val" id="code">--------</div></div>
    <button class="btn" style="background:rgba(255,255,255,.07);color:#fff;border:1px solid var(--border);margin-top:10px" onclick="copyCode()">📋 Copy Code</button>
    <div class="steps">
      <div class="step"><span class="sn">1</span>Open WhatsApp</div>
      <div class="step"><span class="sn">2</span>Linked Devices</div>
      <div class="step"><span class="sn">3</span>Link a Device</div>
      <div class="step"><span class="sn">4</span>Enter the code</div>
    </div>
    <div class="status-msg" id="statusMsg"></div>
  </div>
</div>
<div class="footer">Taragon Squad TRS v4.0.0 · <a href="/health">Health</a></div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  socket.on('status', (d) => {
    document.getElementById('session-display').textContent = d.connected ? 'WhatsApp: +'+d.number : 'Not connected';
  });
  socket.on('code', (d) => {
    document.getElementById('code').textContent = d.code;
    document.getElementById('result').classList.add('show');
    document.getElementById('statusMsg').innerHTML = '<span class="ok">✅ Code ready!</span>';
    resetBtn();
  });
  socket.on('connected', (d) => {
    document.getElementById('statusMsg').innerHTML = '<span class="ok">🎉 Connected as +'+d.num+'</span>';
    resetBtn();
    if(d.sessionId) alert('Session ID: '+d.sessionId);
  });
  socket.on('error', (d) => {
    document.getElementById('statusMsg').innerHTML = '<span class="err">❌ '+d.msg+'</span>';
    resetBtn();
  });
  function resetBtn() {
    document.getElementById('btnText').textContent = '🔗 Generate Pairing Code';
    document.getElementById('pairBtn').disabled = false;
  }
  function requestCode() {
    const phone = document.getElementById('phone').value.replace(/\\D/g, '');
    if (!phone || phone.length < 10) return alert('Invalid phone');
    document.getElementById('btnText').innerHTML = '<span class="spin"></span>Generating…';
    document.getElementById('pairBtn').disabled = true;
    document.getElementById('result').classList.remove('show');
    socket.emit('pair', { phone });
  }
  function copyCode() {
    const code = document.getElementById('code').textContent;
    if (!code || code === '--------') return;
    navigator.clipboard.writeText(code).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = code; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    });
  }
  document.getElementById('phone').addEventListener('keydown', e => { if (e.key === 'Enter') requestCode(); });
</script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), PANEL_HTML);

// ── Socket.io for web panel pairing ──────────────────────────
let webPairingInProgress = false;

io.on('connection', (socket) => {
    socket.emit('status', { connected: !!whatsAppSocket, number: botNumber });

    socket.on('pair', async (data) => {
        if (webPairingInProgress) return socket.emit('error', { msg: 'Another pairing in progress.' });
        const phone = data.phone?.replace(/\D/g, '');
        if (!phone || phone.length < 10) return socket.emit('error', { msg: 'Invalid phone number.' });
        webPairingInProgress = true;

        try {
            if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });

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
            socket.emit('code', { code });

            let connected = false;
            let timedOut = false;
            const timeout = setTimeout(() => {
                if (!connected) {
                    timedOut = true;
                    socket.emit('error', { msg: 'Timed out.' });
                    webPairingInProgress = false;
                    sock.end();
                }
            }, 120_000);

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
                    sessionId = await generateSessionId(AUTH_DIR);
                    webPairingInProgress = false;
                    socket.emit('connected', { num, sessionId });
                    io.emit('status', { connected: true, number: num });
                } else if (connection === 'close' && !connected) {
                    clearTimeout(timeout);
                    socket.emit('error', { msg: 'Connection closed.' });
                    webPairingInProgress = false;
                    sock.end();
                }
            });
        } catch (err) {
            webPairingInProgress = false;
            socket.emit('error', { msg: err.message });
        }
    });
});

// ==================== SERVER START ====================
server.listen(PORT, () => {
    console.log(`\n🇻🇦 TARAGON TELEGRAM BOT – v4.0.0\n   Web: http://localhost:${PORT}\n   Telegram: @your_bot\n`);
});

// Auto‑reconnect to WhatsApp on boot (if session exists)
(async () => {
    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return;
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
                sessionId = await generateSessionId(AUTH_DIR);
                io.emit('status', { connected: true, number: num });
                console.log(`✅ Reconnected WhatsApp: +${num}`);
            } else if (u.connection === 'close') {
                const shouldReconnect = u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting…');
                    setTimeout(() => process.exit(1), 5000);
                }
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.log('Auto‑reconnect error:', e.message);
    }
})();
