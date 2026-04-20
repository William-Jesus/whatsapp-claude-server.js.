require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  // Detecta quando o usuário abre a conversa (unreadCount vai a 0)
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
    try {
      await whatsapp.destroy();
    } catch (_) {}
    whatsapp.initialize();
  }, 5000);
});

// Detecta quando o usuário responde manualmente pelo celular
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

// Recebe mensagens
whatsapp.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;
  if (msg.from.endsWith('@g.us')) return;

  const contact = await msg.getContact();
  const name = contact.name || contact.pushname || contact.number;
  const from = msg.from;
  const body = msg.body || (msg.type !== 'chat' ? `[${msg.type}]` : '');

  if (!body) return;

  console.log(`\n📩 Mensagem de ${name}: ${body}`);

  // Agrupa ou cria item — SÍNCRONO antes de qualquer await
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
    contactPending.set(from, { id, timerId: null }); // reserva antes do await
  }

  // Gera rascunho com Claude
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: `Você é um assistente que ajuda William de Jesus a responder mensagens do WhatsApp.
Escreva respostas naturais, no estilo brasileiro, diretas e amigáveis.
Responda sempre em português. Seja conciso.`,
      messages: [
        {
          role: 'user',
          content: `Mensagens recebidas de ${name}:\n${item.messages.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n\nEscreva uma resposta adequada considerando todas as mensagens.`
        }
      ]
    });
    item.draft = response.content[0].text;
  } catch (err) {
    console.error('Erro ao chamar Claude:', err.message);
  }

  // Se já foi cancelado enquanto aguardava Claude, ignora
  if (!pending.has(item.id)) return;

  // Cancela timer anterior (outra mensagem pode ter setado um entre o await)
  const curr = contactPending.get(from);
  if (curr && curr.timerId) clearTimeout(curr.timerId);

  // (Re)inicia timer de auto-resposta de 2 minutos
  const timerId = setTimeout(async () => {
    if (!pending.has(item.id)) return;
    pending.delete(item.id);
    contactPending.delete(from);
    await whatsapp.sendMessage(from, 'Oi, eu sou a IA do Will! Ele está ocupado e logo te responde. Enquanto isso, eu vou dominando o mundo! 🤖');
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

// API: aprovar e enviar
app.post('/api/approve/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const item = pending.get(id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });

  const text = req.body.text || item.draft;
  try {
    await whatsapp.sendMessage(item.from, text);
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
