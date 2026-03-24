const API_BASE = 'https://api.infinitepay.io';

function resolveCheckoutUrl(payload) {
  return (
    payload.checkout_url ||
    payload.checkoutUrl ||
    payload.payment_link ||
    payload.paymentLink ||
    payload.url ||
    payload.link ||
    payload.data?.checkout_url ||
    payload.data?.url ||
    payload.data?.link ||
    null
  );
}

function resolveProviderReference(payload, fallback) {
  return (
    payload.order_nsu ||
    payload.orderNsu ||
    payload.invoice_id ||
    payload.invoiceId ||
    payload.id ||
    payload.identifier ||
    fallback
  );
}

async function createCheckoutLink({ amount, webhookUrl }) {
  const handle = String(process.env.INFINITEPAY_HANDLE || '').trim();
  if (!handle) {
    throw new Error('INFINITEPAY_HANDLE nao configurada');
  }

  const body = {
    handle,
    items: [
      {
        description: 'Deposito Futoro',
        quantity: 1,
        price: Math.round(amount * 100)
      }
    ]
  };

  // Registra a URL de webhook para notificação automática de pagamento
  if (webhookUrl) {
    body.webhook_url = webhookUrl;
  }

  const response = await fetch(`${API_BASE}/invoices/public/checkout/links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || payload.detail || 'Falha ao criar checkout da InfinitePay');
  }

  const checkoutUrl = resolveCheckoutUrl(payload);
  if (!checkoutUrl) {
    throw new Error('InfinitePay nao retornou URL de checkout');
  }

  return {
    checkoutUrl,
    providerReference: resolveProviderReference(payload, null),
    raw: payload
  };
}

module.exports = {
  createCheckoutLink
};
