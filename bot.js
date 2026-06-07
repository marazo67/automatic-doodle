// ======================== TARAGON TELEGRAM BOT + WA PAIRING + WEB PANEL ========================
// Features: AI chat, Downloaders (YT audio/video, TikTok, Spotify, Instagram, Facebook),
//           Translation, Website checker, WhatsApp pairing via code & QR, Session ID generation.
// Owner: 7784215573 (hardcoded)
// Start: node bot.js
// ==============================================================================================

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
const { exec } = require('child_process');
const { promisify } = require('util');
const yts = require('yt-search');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const execAsync = promisify(exec);

// ========================= CONFIG =========================
const TELEGRAM_TOKEN = '8838166170:AAGzpSpkuSzr01jn7KP5551VrhsS1xF6A9E'; // your token
const OWNER_ID = 7784215573;   // your Telegram user ID
const PORT = process.env.PORT || 3000;
// ==========================================================

// ── Directories ──────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, 'auth_main');
const TEMP_DIR = path.join(__dirname, 'temp');
const PUBLIC_DIR = path.join(__dirname, 'public');
[PUBLIC_DIR, TEMP_DIR, AUTH_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── WhatsApp state ───────────────────────────────────────
let whatsAppSocket = null;
let botNumber = null;
let sessionId = null;

// ── Helpers ──────────────────────────────────────────────
const downloadBuffer = async (url) => {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(resp.data);
};

async function generateSessionId(authDir) {
    const credsPath = path.join(authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    const raw = fs.readFileSync(credsPath, 'utf8').substring(0, 64);
    const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
    return `TRS-${hash.substring(0, 15)}`;
}

// ── AI APIs ──────────────────────────────────────────────
const ALL_AI_APIS = [
    { name:'ZellAPI', url:(q)=>`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(q)}`, extract:(d)=>d?.result },
    { name:'Vapis Gemini', url:(q)=>`https://vapis.my.id/api/gemini?q=${encodeURIComponent(q)}`, extract:(d)=>d?.message },
    { name:'Siputzx', url:(q)=>`https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(q)}`, extract:(d)=>d?.data },
    { name:'Ryzen', url:(q)=>`https://api.ryzendesu.vip/api/ai/gemini?text=${encodeURIComponent(q)}`, extract:(d)=>d?.answer },
];

async function getAIResponse(userMessage) {
    const prompt = `You're Scottie Kiidrsa, a real person. Reply in 1-2 lines max. Use Hinglish naturally. Be savage if abused, sweet if treated well. NEVER say you're AI. Message: ${userMessage}`;
    for (const api of ALL_AI_APIS) {
        try {
            const res = await axios.get(api.url(prompt), { timeout: 8000 });
            const answer = api.extract(res.data);
            if (answer && typeof answer === 'string' && answer.length > 2) return answer.trim();
        } catch {}
    }
    return "Haan bhai! 😊";
}

// ── Downloader helpers ───────────────────────────────────
async function searchYouTube(query) {
    const result = await yts(query);
    if (!result?.videos?.length) throw new Error('No results found.');
    return result.videos[0];
}

async function downloadAudio(videoUrl) {
    const apis = [
        { url:`https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(videoUrl)}&format=mp3`, extract:d=>d?.data?.downloadURL },
        { url:`https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}`, extract:d=>d?.data?.data?.download_url },
    ];
    for (const api of apis) {
        try {
            const res = await axios.get(api.url, { timeout: 30000 });
            const dlUrl = api.extract(res);
            if (dlUrl) return downloadBuffer(dlUrl);
        } catch {}
    }
    // yt-dlp fallback
    const out = path.join(TEMP_DIR, `audio_${Date.now()}.mp3`);
    await execAsync(`yt-dlp -x --audio-format mp3 -o "${out}" "${videoUrl}"`, { timeout: 120000 });
    if (fs.existsSync(out)) {
        const buf = fs.readFileSync(out);
        fs.unlinkSync(out);
        return buf;
    }
    throw new Error('All download methods failed.');
}

async function downloadVideo(url) {
    const out = path.join(TEMP_DIR, `video_${Date.now()}.mp4`);
    await execAsync(`yt-dlp -f "best[ext=mp4]" -o "${out}" "${url}"`, { timeout: 300000 });
    if (!fs.existsSync(out)) throw new Error('Video download failed.');
    const buf = fs.readFileSync(out);
    fs.unlinkSync(out);
    return buf;
}

// ======================== TELEGRAM BOT ============================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => console.error('Telegram polling error:', error));
bot.on('webhook_error', (error) => console.error('Telegram webhook error:', error));

// Helper: check if user is owner
const isOwner = (msg) => msg.from.id === OWNER_ID;

// ── /start ──────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const status = whatsAppSocket
        ? `✅ WhatsApp: +${botNumber}\nSession ID: <code>${sessionId}</code>`
        : `⚠️ WhatsApp not paired. Use /pair <phone> or /qr.`;
    const menu = `🇻🇦 <b>TARAGON SQUAD TRS</b>

${status}

<b>📥 Downloaders:</b>
/play <song> – audio + metadata
/ytmp4 <url> – video
/tiktok <url>
/spotify <song>
/instagram <url>
/facebook <url>

<b>🤖 AI:</b>
/gpt <query>
/imagine <prompt>

<b>🛠 Utils:</b>
/trt <text> <lang>
/check <host>

<b>👑 Owner:</b>
/pair <phone>
/qr
/status
/logout`;
    bot.sendMessage(chatId, menu, { parse_mode: 'HTML', disable_web_page_preview: true });
});

// ── Downloaders ─────────────────────────────────────────────────
bot.onText(/\/play(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];
    if (!query) return bot.sendMessage(chatId, 'Usage: /play <song name or YouTube URL>');
    try {
        await bot.sendChatAction(chatId, 'typing');
        const video = await searchYouTube(query);
        const { title, url, timestamp, views, image } = video;

        let caption = `<b>🎵 ${title}</b>\n`;
        if (timestamp) caption += `⏱ Duration: ${timestamp}\n`;
        if (views) caption += `👁 Views: ${views}\n`;
        caption += `🔗 <a href="${url}">YouTube</a>`;

        if (image) {
            await bot.sendPhoto(chatId, image, { caption, parse_mode: 'HTML' });
        } else {
            await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
        }

        await bot.sendChatAction(chatId, 'upload_voice');
        const audioBuffer = await downloadAudio(url);
        await bot.sendAudio(chatId, audioBuffer, {
            title,
            performer: 'YouTube',
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
        const buffer = await downloadVideo(url);
        await bot.sendVideo(chatId, buffer, { caption: '📹 Downloaded video' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ Error: ${e.message}`);
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

// ── AI & Utils ─────────────────────────────────────────────────
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
        if (!url) throw new Error('No image URL');
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

// ── Owner Commands ──────────────────────────────────────────────
bot.onText(/\/pair(?: (.+))?/, (msg, match) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '❌ Owner only.');
    const phone = match[1]?.replace(/\D/g, '');
    if (!phone || phone.length < 10) return bot.sendMessage(msg.chat.id, 'Usage: /pair 1234567890');
    startPairing(msg.chat.id, phone, 'code');
});

bot.onText(/\/qr/, (msg) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '❌ Owner only.');
    startPairing(msg.chat.id, null, 'qr');
});

bot.onText(/\/status/, (msg) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '❌ Owner only.');
    if (whatsAppSocket) {
        bot.sendMessage(msg.chat.id, `✅ Connected: +${botNumber}\nSession ID: <code>${sessionId}</code>`, { parse_mode: 'HTML' });
    } else {
        bot.sendMessage(msg.chat.id, '❌ Not connected.');
    }
});

bot.onText(/\/logout/, (msg) => {
    if (!isOwner(msg)) return bot.sendMessage(msg.chat.id, '❌ Owner only.');
    if (!whatsAppSocket) return bot.sendMessage(msg.chat.id, '⚠️ No active connection.');
    whatsAppSocket.end();
    whatsAppSocket = null;
    botNumber = null;
    sessionId = null;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    bot.sendMessage(msg.chat.id, '🛑 Disconnected and session cleared.');
});

// ==================== WHATSAPP PAIRING LOGIC ====================
let pairingInProgress = false;
let currentPairingSocket = null;

async function startPairing(chatId, phone, method) {
    if (pairingInProgress) return bot.sendMessage(chatId, '⏳ Another pairing is in progress.');
    pairingInProgress = true;

    // Clean old session
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
            await bot.sendMessage(chatId, `<b>📲 Pairing Code</b>\n<code>${code}</code>\n\n1. Open WhatsApp → Linked Devices\n2. Tap Link a Device\n3. Enter code\n\nTimeout 3 min`, { parse_mode: 'HTML' });
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
                    await bot.sendPhoto(chatId, qrImage, { caption: '📷 Scan with WhatsApp (Linked Devices)\nValid 2 min' });
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

                await bot.sendMessage(chatId, `✅ Connected as +${num}\n<b>Session ID:</b> <code>${sessionId}</code>`, { parse_mode: 'HTML' });
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

// ==================== WEB SERVER & PAIRING PANEL ====================
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(PUBLIC_DIR));

// ── Web panel HTML (beautiful UI) ──────────────────────────────
const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TARAGON – Web Pairing</title>
<style>
  :root{--bg:#060810;--surface:#0d1117;--border:rgba(255,255,255,0.06);--accent:#5865f2;--accent2:#eb459e;--green:#3ba55d;--red:#ed4245;--text:#e3e5e8;--muted:#72767d}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',sans-serif;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:40px 30px;max-width:420px;width:100%;text-align:center}
  h1{font-size:28px;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
  .sub{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
  .status{margin:20px 0;font-size:14px;color:var(--muted)}
  .input-wrap{position:relative;margin:16px 0}
  input{width:100%;padding:14px 14px 14px 40px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:12px;color:var(--text);font-size:15px;outline:none}
  input:focus{border-color:var(--accent)}
  .icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:18px}
  .btn{width:100%;padding:14px;border:none;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer;transition:.2s;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;margin-top:10px}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .result{display:none;margin-top:20px}
  .result.show{display:block}
  .code{font-family:monospace;font-size:36px;letter-spacing:8px;color:var(--accent);background:#0a0c10;padding:20px;border-radius:12px}
  .session{font-family:monospace;font-size:14px;background:rgba(88,101,242,.1);padding:8px;border-radius:8px;margin:8px 0}
  .steps{text-align:left;font-size:13px;color:rgba(255,255,255,.65);margin-top:12px}
  .steps div{margin:4px 0}
  .msg{margin-top:12px;font-size:13px}
  .ok{color:var(--green)} .err{color:var(--red)}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
  <h1>🇻🇦 TARAGON SQUAD TRS</h1>
  <div class="sub">WhatsApp Pairing Panel</div>
  <div class="status" id="statusLine">Not connected</div>
  <div class="input-wrap">
    <span class="icon">📱</span>
    <input id="phone" type="tel" placeholder="Phone with country code" maxlength="15">
  </div>
  <button class="btn" id="pairBtn" onclick="requestCode()">🔗 Generate Pairing Code</button>
  <div class="result" id="resultBox">
    <div class="code" id="codeDisplay">--------</div>
    <div class="session" id="sessionDisplay" style="display:none"></div>
    <button class="btn" style="background:rgba(255,255,255,.07);margin-top:8px" onclick="copyCode()">📋 Copy Code</button>
    <div class="steps">
      <div>1️⃣ Open WhatsApp</div>
      <div>2️⃣ Linked Devices</div>
      <div>3️⃣ Link a Device</div>
      <div>4️⃣ Enter the code above</div>
    </div>
    <div class="msg" id="message"></div>
  </div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const statusLine = document.getElementById('statusLine');
  const pairBtn = document.getElementById('pairBtn');
  const codeDisplay = document.getElementById('codeDisplay');
  const sessionDisplay = document.getElementById('sessionDisplay');
  const resultBox = document.getElementById('resultBox');
  const message = document.getElementById('message');

  socket.on('status', (d) => {
    if (d.connected) {
      statusLine.innerHTML = `✅ WhatsApp: +${d.number}${d.sessionId ? '<br>Session ID: ' + d.sessionId : ''}`;
    } else {
      statusLine.textContent = 'Not connected';
    }
  });

  socket.on('code', (d) => {
    codeDisplay.textContent = d.code;
    resultBox.classList.add('show');
    message.innerHTML = '<span class="ok">✅ Code ready! Enter it in WhatsApp.</span>';
    pairBtn.disabled = false;
    pairBtn.innerHTML = '🔗 Generate Pairing Code';
  });

  socket.on('connected', (d) => {
    message.innerHTML = '<span class="ok">🎉 Connected as +' + d.num + '</span>';
    if (d.sessionId) {
      sessionDisplay.style.display = 'block';
      sessionDisplay.textContent = 'Session ID: ' + d.sessionId;
    }
    pairBtn.disabled = false;
    pairBtn.innerHTML = '🔗 Generate Pairing Code';
    statusLine.innerHTML = `✅ WhatsApp: +${d.num}${d.sessionId ? '<br>Session ID: ' + d.sessionId : ''}`;
  });

  socket.on('error', (d) => {
    message.innerHTML = '<span class="err">❌ ' + d.msg + '</span>';
    pairBtn.disabled = false;
    pairBtn.innerHTML = '🔗 Generate Pairing Code';
  });

  function requestCode() {
    const phone = document.getElementById('phone').value.replace(/\\D/g, '');
    if (!phone || phone.length < 10) return alert('Enter a valid phone number.');
    pairBtn.disabled = true;
    pairBtn.innerHTML = '<span class="spin"></span>Generating…';
    resultBox.classList.remove('show');
    message.innerHTML = '';
    sessionDisplay.style.display = 'none';
    socket.emit('pair', { phone });
  }

  function copyCode() {
    const code = codeDisplay.textContent;
    if (code === '--------') return;
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

fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), PANEL_HTML);

// ── Socket.io for web panel pairing ──────────────────────────
let webPairingInProgress = false;

io.on('connection', (socket) => {
    // Send current status
    socket.emit('status', {
        connected: !!whatsAppSocket,
        number: botNumber,
        sessionId: sessionId
    });

    socket.on('pair', async (data) => {
        if (webPairingInProgress) return socket.emit('error', { msg: 'Another pairing is in progress.' });
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
                    io.emit('status', { connected: true, number: num, sessionId });
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

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: !!whatsAppSocket, sessionId }));

// ==================== SERVER START ====================
server.listen(PORT, () => {
    console.log(`\n🇻🇦 TARAGON TELEGRAM BOT + WEB PANEL – v4.0.0`);
    console.log(`   Web panel: http://localhost:${PORT}`);
    console.log(`   Telegram bot is live. Send /start\n`);
});

// ==================== AUTO-RECONNECT ON BOOT ====================
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
                console.log(`✅ WhatsApp reconnected: +${num}`);
                io.emit('status', { connected: true, number: num, sessionId });
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.log('Auto‑reconnect error:', e.message);
    }
})();
