// index.js
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');

const app = express();
const PORT = process.env.PORT || 3000;

// Load config from env
const MONGO_URI = process.env.MONGO_URI;
const SOURCE_GROUPS = (process.env.SOURCE_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean);
const TARGET_GROUP = process.env.TARGET_GROUP;
const FORWARD_CAPTION = process.env.FORWARD_CAPTION || 'Auto-Forwarded';

// basic validation
if (!MONGO_URI) {
  console.error('MONGO_URI not set. Exiting.');
  process.exit(1);
}
if (!TARGET_GROUP) {
  console.error('TARGET_GROUP not set. Exiting.');
  process.exit(1);
}
if (SOURCE_GROUPS.length === 0) {
  console.warn('SOURCE_GROUPS empty — no sources configured. Set SOURCE_GROUPS env var.');
}

// connect mongoose
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// create store for session persistence
const store = new MongoStore({ mongoose: mongoose });

// create client with LocalAuth using MongoStore
const client = new Client({
  authStrategy: new LocalAuth({
    store: store
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  }
});

let latestQrData = null;

// QR handler: store the data URL so we can expose /qr for scanning in browser
client.on('qr', (qr) => {
  latestQrData = qr; // data:image/png;base64,...
  console.log('QR code received. Open /qr on this service to view it and scan with WhatsApp.');
});

// ready
client.on('ready', () => {
  console.log('WhatsApp client ready!');
  latestQrData = null;
});

// auth failure
client.on('auth_failure', (msg) => {
  console.error('Authentication failure:', msg);
});

// add message handler for forwarding images
client.on('message', async (msg) => {
  try {
    // ignore messages sent by the bot itself
    if (msg.fromMe) return;

    // guarantee group message (endsWith @g.us)
    if (!msg.from || !msg.from.endsWith('@g.us')) return;

    // avoid forwarding messages that originate in the target group
    if (msg.from === TARGET_GROUP) return;

    // only forward if the message is from one of the source groups
    if (!SOURCE_GROUPS.includes(msg.from)) return;

    // check for media
    if (!msg.hasMedia) return;

    const media = await msg.downloadMedia();
    if (!media || !media.mimetype) return;

    // only forward images (change if you want other media types)
    if (!media.mimetype.startsWith('image/')) return;

    // build MessageMedia and send to target group
    const forwarded = await client.sendMessage(TARGET_GROUP, media, { caption: FORWARD_CAPTION });
    console.log(`Forwarded image from ${msg.from} to ${TARGET_GROUP} (id: ${forwarded.id._serialized})`);
  } catch (err) {
    console.error('Auto-forward error:', err);
  }
});

// initialize client
client.initialize();

// Express endpoints
app.get('/', (req, res) => res.send('WhatsApp auto-forward bot (Mongo session)'));

app.get('/health', (req, res) => res.send('OK'));

// QR viewer: returns PNG to scan in phone (only present while there's a QR)
app.get('/qr', (req, res) => {
  if (!latestQrData) return res.status(404).send('No QR currently available (client may already be authenticated).');
  try {
    const base64Data = latestQrData.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buffer.length
    });
    res.end(buffer);
  } catch (err) {
    res.status(500).send('Failed to render QR');
  }
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});