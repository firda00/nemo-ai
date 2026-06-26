// WhatsApp Cloud API + Instagram (Meta Graph) send helpers.

export async function waSend(phoneNumberId: string, token: string, to: string, text: string): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  })
  return res.ok
}

export async function igSend(token: string, recipientId: string, text: string): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  })
  return res.ok
}
