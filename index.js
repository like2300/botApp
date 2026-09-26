const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

// ⚙️ CONFIGURATION
const MISTRAL_API_KEY = "VOTRE_CLE_MISTRAL_ICI"; // Remplacez par votre nouvelle clé Mistral
const SYSTEM_INSTRUCTIONS = "Tu es un assistant virtuel utile, poli et court dans tes réponses sur WhatsApp.";

// Fonction pour envoyer le message à Mistral API
async function askMistral(userMessage) {
    try {
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${MISTRAL_API_KEY}`
            },
            body: JSON.stringify({
                model: 'mistral-small-latest',
                messages: [
                    { role: 'system', content: SYSTEM_INSTRUCTIONS },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.7,
                max_tokens: 500
            })
        });

        const data = await response.json();
        if (data.choices && data.choices.length > 0) {
            return data.choices[0].message.content;
        } else {
            console.error('Erreur API Mistral :', data);
            return null;
        }
    } catch (error) {
        console.error('Erreur Réseau Mistral :', error);
        return null;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📲 Scannez ce QR Code avec WhatsApp :\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot WhatsApp connecté et relié à Mistral AI !');
        }
    });

    // Écoute et réponse aux messages WhatsApp
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                // Vérifie que le message vient d'un utilisateur et n'est pas envoyé par le bot lui-même
                if (!msg.key.fromMe && msg.message) {
                    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                    const from = msg.key.remoteJid;

                    // Ignorer les messages de groupes si vous voulez uniquement les chats privés
                    if (from.endsWith('@g.us')) continue;

                    if (text) {
                        console.log(`📩 Message de ${from} : ${text}`);

                        // Appel à l'IA Mistral
                        const aiReply = await askMistral(text);

                        if (aiReply) {
                            // Envoi de la réponse générée par Mistral sur WhatsApp
                            await sock.sendMessage(from, { text: aiReply });
                            console.log(`🤖 Réponse envoyée à ${from}`);
                        }
                    }
                }
            }
        }
    });
}

startBot();