const BASE_URLS = {
  production: 'https://api.asaas.com/v3',
  sandbox: 'https://sandbox.asaas.com/api/v3'
};

function getBaseUrl() {
  return BASE_URLS[process.env.ASAAS_ENV] || BASE_URLS.production;
}

async function asaasRequest(method, path, body = null) {
  const apiKey = process.env.ASAAS_API_KEY;
  if (!apiKey) throw new Error('ASAAS_API_KEY nao configurada');

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'access_token': apiKey
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${getBaseUrl()}${path}`, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data.errors?.[0]?.description ||
      data.description ||
      `Erro na API Asaas (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Retorna o customer_id do Asaas para o usuário.
 * Se já tiver um salvo, retorna direto sem chamar a API.
 * Caso contrário, cria o customer e retorna o novo ID.
 */
async function ensureCustomer({ asaasCustomerId, name, cpf, email }) {
  if (asaasCustomerId) return asaasCustomerId;

  const data = await asaasRequest('POST', '/customers', {
    name,
    cpfCnpj: cpf,
    email,
    notificationDisabled: true // suprime emails próprios do Asaas ao usuário
  });
  return data.id;
}

/**
 * Cria uma cobrança PIX no Asaas.
 * dueDate = amanhã (Asaas exige uma data futura).
 * externalReference = UUID do depósito no nosso banco.
 */
async function createPixCharge({ customerId, amount, externalReference, description }) {
  const due = new Date();
  due.setDate(due.getDate() + 1);
  const dueDate = due.toISOString().split('T')[0]; // 'YYYY-MM-DD'

  return asaasRequest('POST', '/payments', {
    customer: customerId,
    billingType: 'PIX',
    value: amount,
    dueDate,
    externalReference,
    description: description || 'Deposito Bubuya'
  });
}

/**
 * Busca o QR Code PIX de uma cobrança já criada.
 * Retorna { payload (copia-e-cola), encodedImage (base64 PNG) }
 */
async function getPixQrCode(paymentId) {
  return asaasRequest('GET', `/payments/${paymentId}/pixQrCode`);
}

module.exports = { ensureCustomer, createPixCharge, getPixQrCode };
