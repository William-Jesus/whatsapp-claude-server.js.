require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Banco de dados
const db = new Database(path.join(__dirname, 'conversations.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_num  TEXT NOT NULL,
    name      TEXT NOT NULL,
    role      TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content   TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_num, created_at);
`);

const MAX_HISTORY_PAIRS = 6;

function loadHistory(from) {
  const rows = db.prepare(`
    SELECT role, content FROM messages
    WHERE from_num = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(from, MAX_HISTORY_PAIRS * 2);
  return rows.reverse(); // cronológico
}

function saveMessage(from, name, role, content) {
  db.prepare(`
    INSERT INTO messages (from_num, name, role, content) VALUES (?, ?, ?, ?)
  `).run(from, name, role, content);
}

// Fila de mensagens pendentes de aprovação
const pending = new Map();       // id → item
const contactPending = new Map(); // from → { id, timerId }
let pendingCounter = 0;

const whatsapp = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
    ]
  }
});

whatsapp.on('qr', (qr) => {
  console.log('\n📱 Escaneie o QR Code com seu WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

whatsapp.on('ready', () => {
  console.log('✅ WhatsApp conectado!');
  console.log('🌐 Acesse: http://localhost:3000\n');

  setInterval(async () => {
    for (const [from, { id, timerId }] of contactPending.entries()) {
      try {
        const chat = await whatsapp.getChatById(from);
        if (chat.unreadCount === 0) {
          clearTimeout(timerId);
          pending.delete(id);
          contactPending.delete(from);
          console.log(`👁️ Conversa aberta — pendente cancelado para ${chat.name || from}`);
        }
      } catch (_) {}
    }
  }, 10000);
});

whatsapp.on('disconnected', async (reason) => {
  console.log(`⚠️ WhatsApp desconectado: ${reason}. Reconectando em 5s...`);
  setTimeout(async () => {
    try { await whatsapp.destroy(); } catch (_) {}
    whatsapp.initialize();
  }, 5000);
});

whatsapp.on('message_create', async (msg) => {
  if (!msg.fromMe) return;
  if (msg.to === 'status@broadcast') return;
  if (msg.to && contactPending.has(msg.to)) {
    const existing = contactPending.get(msg.to);
    clearTimeout(existing.timerId);
    pending.delete(existing.id);
    contactPending.delete(msg.to);
    console.log(`✋ Resposta manual detectada — pendente cancelado para ${msg.to}`);
  }
});

whatsapp.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;
  if (msg.from.endsWith('@g.us')) return;

  const contact = await msg.getContact();
  const name = contact.name || contact.pushname || contact.number;
  const from = msg.from;
  const body = msg.body || (msg.type !== 'chat' ? `[${msg.type}]` : '');

  if (!body) return;

  console.log(`\n📩 Mensagem de ${name}: ${body}`);

  const existing = contactPending.get(from);
  let item;
  if (existing) {
    item = pending.get(existing.id);
    item.messages.push(body);
    if (existing.timerId) clearTimeout(existing.timerId);
    contactPending.set(from, { id: existing.id, timerId: null });
  } else {
    const id = ++pendingCounter;
    item = { id, name, from, messages: [body], draft: '', timestamp: new Date() };
    pending.set(id, item);
    contactPending.set(from, { id, timerId: null });
  }

  // Gera rascunho com Claude usando histórico do banco
  try {
    const history = loadHistory(from);
    const currentContent = item.messages.length === 1
      ? item.messages[0]
      : item.messages.map((m, i) => `${i + 1}. "${m}"`).join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: `Você é um assistente que ajuda William de Jesus a responder mensagens do WhatsApp.
Escreva respostas naturais, no estilo brasileiro, diretas e amigáveis.
Responda sempre em português. Seja conciso.
Use o histórico da conversa para dar respostas contextualizadas.`,
      messages: [
        ...history,
        { role: 'user', content: currentContent }
      ]
    });
    item.draft = response.content[0].text;
  } catch (err) {
    console.error('Erro ao chamar Claude:', err.message);
  }

  if (!pending.has(item.id)) return;

  const curr = contactPending.get(from);
  if (curr && curr.timerId) clearTimeout(curr.timerId);

  const timerId = setTimeout(async () => {
    if (!pending.has(item.id)) return;
    pending.delete(item.id);
    contactPending.delete(from);
    await whatsapp.sendMessage(from, 'Oi, eu sou a IA do Will! Ele está ocupado e logo te responde. Enquanto isso, ele está salvando o mundo! 🤖');
    console.log(`⏱️ Auto-resposta enviada para ${name}`);
  }, 2 * 60 * 1000);

  if (contactPending.has(from) && contactPending.get(from).id === item.id) {
    contactPending.set(from, { id: item.id, timerId });
  } else {
    clearTimeout(timerId);
  }

  console.log(`💬 Rascunho gerado. Acesse http://localhost:3000 para aprovar.`);
});

// API: listar mensagens pendentes
app.get('/api/pending', (req, res) => {
  res.json(Array.from(pending.values()).reverse());
});

// API: histórico de um contato
app.get('/api/history/:from', (req, res) => {
  const rows = db.prepare(`
    SELECT role, content, created_at FROM messages
    WHERE from_num = ?
    ORDER BY created_at ASC
  `).all(req.params.from);
  res.json(rows);
});

// API: lista de contatos com histórico
app.get('/api/contacts', (req, res) => {
  const rows = db.prepare(`
    SELECT from_num, name, COUNT(*) as total, MAX(created_at) as last_message
    FROM messages
    GROUP BY from_num
    ORDER BY last_message DESC
  `).all();
  res.json(rows);
});

// API: aprovar e enviar
app.post('/api/approve/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const item = pending.get(id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });

  const text = req.body.text || item.draft;
  try {
    await whatsapp.sendMessage(item.from, text);

    // Salva a troca no banco
    const userContent = item.messages.length === 1
      ? item.messages[0]
      : item.messages.map((m, i) => `${i + 1}. "${m}"`).join('\n');
    saveMessage(item.from, item.name, 'user', userContent);
    saveMessage(item.from, item.name, 'assistant', text);

    pending.delete(id);
    contactPending.delete(item.from);
    console.log(`✅ Mensagem enviada para ${item.name}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: rejeitar
app.delete('/api/reject/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const item = pending.get(id);
  if (item) contactPending.delete(item.from);
  pending.delete(id);
  console.log(`🗑️ Mensagem rejeitada`);
  res.json({ ok: true });
});

whatsapp.initialize();
app.listen(3000);
