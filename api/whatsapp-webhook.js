const invokeChatPost = require('./_invoke-chat');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const MAX_IMAGES_PER_SUGGESTION = Math.min(
  10,
  Math.max(1, Number.parseInt(process.env.WHATSAPP_MAX_IMAGES_PER_PROPERTY || '3', 10) || 3)
);
const SEND_PREVIEW_IMAGES = process.env.WHATSAPP_SEND_PREVIEW_IMAGES !== '0';

function getSendConfig() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return { token, phoneNumberId, ok: Boolean(token && phoneNumberId) };
}

async function graphSend(token, phoneNumberId, payload) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WhatsApp Graph ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function sendWhatsAppText(toDigits, bodyText) {
  const { token, phoneNumberId, ok } = getSendConfig();
  if (!ok) {
    console.warn('WHATSAPP_SKIP_SEND: missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID');
    return null;
  }
  const chunkMax = 3900;
  let rest = String(bodyText || '');
  while (rest.length > 0) {
    const chunk = rest.slice(0, chunkMax);
    rest = rest.slice(chunkMax);
    await graphSend(token, phoneNumberId, {
      messaging_product: 'whatsapp',
      to: toDigits,
      type: 'text',
      text: { preview_url: true, body: chunk }
    });
  }
}

async function sendWhatsAppImage(toDigits, imageUrl, caption) {
  const { token, phoneNumberId, ok } = getSendConfig();
  if (!ok) return null;
  const cap =
    caption && String(caption).trim()
      ? String(caption).trim().slice(0, 1024)
      : undefined;
  await graphSend(token, phoneNumberId, {
    messaging_product: 'whatsapp',
    to: toDigits,
    type: 'image',
    image: {
      link: String(imageUrl).trim(),
      ...(cap ? { caption: cap } : {})
    }
  });
}

function extractInbound(body) {
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      const messages = change?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        const from = msg?.from;
        if (!from) continue;
        if (msg?.type === 'text') {
          out.push({ from: String(from), type: 'text', text: String(msg?.text?.body || '').trim() });
        } else {
          out.push({ from: String(from), type: msg?.type || 'unknown', text: '' });
        }
      }
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';

  if (req.method === 'GET') {
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];
    if (mode === 'subscribe' && token && verifyToken && token === verifyToken) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      return res.end(String(challenge || ''));
    }
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }

  if (!verifyToken) {
    res.statusCode = 503;
    return res.json({ error: 'WHATSAPP_VERIFY_TOKEN no configurado' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      res.statusCode = 400;
      return res.json({ error: 'JSON inválido' });
    }
  }

  const inbound = extractInbound(payload);
  if (inbound.length === 0) {
    res.statusCode = 200;
    return res.json({ ok: true, processed: 0 });
  }

  try {
    for (const ev of inbound) {
      if (ev.type !== 'text') {
        await sendWhatsAppText(
          ev.from,
          'Por ahora solo puedo leer mensajes de texto. Escribime zona, tipo de propiedad y si es *alquiler* o *venta*.'
        );
        continue;
      }
      if (!ev.text) continue;

      const phone = `wa_${ev.from}`;
      const { statusCode, data } = await invokeChatPost({ message: ev.text, phone });

      if (statusCode >= 400 || !data) {
        await sendWhatsAppText(
          ev.from,
          data?.response ||
            'Hubo un problema al consultar el catálogo. Probá de nuevo en unos segundos con zona + tipo + operación.'
        );
        continue;
      }

      if (data.limitReached && data.response) {
        await sendWhatsAppText(ev.from, data.response);
        continue;
      }

      if (data.response) {
        await sendWhatsAppText(ev.from, data.response);
      }

      if (SEND_PREVIEW_IMAGES) {
        const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
        for (let i = 0; i < suggestions.length; i += 1) {
          const s = suggestions[i];
          const urls = Array.isArray(s.previewImages) ? s.previewImages.filter(Boolean) : [];
          const slice = urls.slice(0, MAX_IMAGES_PER_SUGGESTION);
          for (let j = 0; j < slice.length; j += 1) {
            const caption =
              j === 0
                ? [`${i + 1}.`, s.title || 'Propiedad', s.zone ? `· ${s.zone}` : '', s.listingUrl ? `· ${s.listingUrl}` : '']
                    .filter(Boolean)
                    .join(' ')
                    .trim()
                    .slice(0, 1024)
                : undefined;
            try {
              await sendWhatsAppImage(ev.from, slice[j], caption);
            } catch (imageErr) {
              console.error('WHATSAPP_IMAGE_FAIL:', imageErr?.message || imageErr);
            }
          }
        }
      }
    }

    res.statusCode = 200;
    return res.json({ ok: true, processed: inbound.length });
  } catch (err) {
    console.error('whatsapp-webhook:', err?.message || err);
    res.statusCode = 200;
    return res.json({ ok: false, error: err?.message || 'unknown' });
  }
};
