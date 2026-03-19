/**
 * kyc.js — Rotas de KYC/AML
 *
 * Usuário:
 *   GET  /kyc/status              → status atual do KYC
 *   POST /kyc/submit              → enviar CPF, nome completo e data de nascimento
 *   POST /kyc/document            → enviar referência de documento (URL ou base64)
 *
 * Admin:
 *   GET  /kyc/admin/pending       → lista usuários com KYC em análise
 *   POST /kyc/admin/:userId/approve → aprovar KYC
 *   POST /kyc/admin/:userId/reject  → rejeitar KYC com motivo
 *   GET  /kyc/admin/coaf-flags    → lista flags COAF pendentes
 *   POST /kyc/admin/coaf-flags/:id/resolve → resolve flag COAF
 */
const express = require('express');
const router  = express.Router();
const pool = require('../lib/db');
const auth = require('../middleware/auth');
const logger = require('../lib/logger');
const { logUserAction } = require('../lib/user-audit');
const { validateCPF, maskCPF, KYC_STATUS } = require('../lib/kyc');
const { verifyCPF, verifyDocument } = require('../lib/kyc-bureau');
const { runFullScreening } = require('../lib/pep-screening');
const adminAuth = require('../middleware/adminAuth'); // suporta JWT Bearer e x-admin-secret
const { createDiditSession, getSessionDecision, verifyWebhookSignature, mapDiditStatus } = require('../lib/didit-bureau');
const { APP_URL } = require('../lib/appConfig');

const BUREAU_PROVIDER = process.env.BUREAU_PROVIDER || 'stub';

// ── USER ROUTES ──────────────────────────────────────────────────────────────

/**
 * GET /kyc/status
 * Retorna o status KYC atual e os dados já enviados (sem dados sensíveis completos).
 */
router.get('/status', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        kyc_status,
        kyc_submitted_at,
        kyc_approved_at,
        kyc_rejected_at,
        kyc_rejection_reason,
        full_name,
        date_of_birth,
        CASE WHEN cpf IS NOT NULL THEN TRUE ELSE FALSE END AS cpf_submitted
      FROM users WHERE id = $1
    `, [req.user.id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const u = result.rows[0];
    res.json({
      ok: true,
      kyc_status: u.kyc_status || KYC_STATUS.PENDING,
      submitted_at: u.kyc_submitted_at,
      approved_at: u.kyc_approved_at,
      rejected_at: u.kyc_rejected_at,
      rejection_reason: u.kyc_rejection_reason,
      has_cpf: u.cpf_submitted,
      has_name: !!u.full_name,
      has_dob: !!u.date_of_birth,
    });
  } catch (err) {
    logger.error('KYC status error', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /kyc/submit
 * Envia dados pessoais para verificação.
 * Body: { cpf, full_name, date_of_birth }
 */
router.post('/submit', auth, async (req, res) => {
  try {
    const { cpf, full_name, date_of_birth } = req.body;

    logger.info('KYC submission attempt', {
      userId: req.user.id,
      ip: req.ip
    });

    // Validações básicas
    if (!cpf || !full_name || !date_of_birth) {
      return res.status(400).json({
        error: 'CPF, nome completo e data de nascimento são obrigatórios'
      });
    }

    // Verifica status atual — não permite reenvio se já aprovado
    const currentStatus = await pool.query(
      'SELECT kyc_status FROM users WHERE id = $1',
      [req.user.id]
    );
    const status = currentStatus.rows[0]?.kyc_status;

    if (status === KYC_STATUS.APPROVED) {
      return res.status(400).json({
        error: 'KYC já aprovado. Não é necessário reenviar.'
      });
    }
    if (status === KYC_STATUS.SUBMITTED) {
      return res.status(400).json({
        error: 'Seus documentos já estão em análise. Aguarde a revisão.'
      });
    }

    // Valida CPF
    const cpfValidation = validateCPF(cpf);
    if (!cpfValidation.valid) {
      logger.warn('KYC CPF validation failed', {
        userId: req.user.id,
        error: cpfValidation.error,
        ip: req.ip
      });
      return res.status(400).json({ error: cpfValidation.error });
    }

    // Verifica se CPF já está em uso por outro usuário
    const cpfExists = await pool.query(
      'SELECT id FROM users WHERE cpf = $1 AND id != $2',
      [cpfValidation.cleaned, req.user.id]
    );
    if (cpfExists.rows.length) {
      logger.warn('KYC CPF duplicate attempt', {
        userId: req.user.id,
        cpfMasked: maskCPF(cpfValidation.cleaned),
        ip: req.ip
      });
      return res.status(400).json({ error: 'CPF já cadastrado em outra conta' });
    }

    // Valida data de nascimento (mínimo 18 anos)
    const dob = new Date(date_of_birth);
    if (isNaN(dob.getTime())) {
      return res.status(400).json({ error: 'Data de nascimento inválida' });
    }
    const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
    if (age < 18) {
      return res.status(400).json({ error: 'É necessário ter 18 anos ou mais para operar' });
    }

    // ── DIDIT: fluxo assíncrono (redirect para verificação de documento) ────────
    if (BUREAU_PROVIDER === 'didit') {
      // 1. Criar sessão no Didit PRIMEIRO — se falhar, não alteramos o DB
      const callbackUrl = `${APP_URL}/kyc.html?didit_return=1`;
      let session;
      try {
        session = await createDiditSession({
          userId:      req.user.id,
          fullName:    full_name.trim(),
          cpf:         cpfValidation.cleaned,
          dateOfBirth: date_of_birth,
          callbackUrl,
        });
      } catch (diditErr) {
        logger.error('[DIDIT] Falha ao criar sessão — sem alteração no DB', {
          userId: req.user.id,
          error:  diditErr.message,
        });
        // Retorna erro amigável mas não altera kyc_status
        return res.status(503).json({
          error: 'Serviço de verificação de identidade temporariamente indisponível. Tente novamente em instantes.',
        });
      }

      // 2. Sessão criada com sucesso → agora salva no DB
      await pool.query(`
        UPDATE users SET
          cpf = $1, full_name = $2, date_of_birth = $3,
          kyc_status = 'submitted', kyc_submitted_at = NOW(),
          kyc_rejected_at = NULL, kyc_rejection_reason = NULL,
          kyc_provider_id = $4
        WHERE id = $5
      `, [cpfValidation.cleaned, full_name.trim(), date_of_birth, session.session_id, req.user.id]);

      await pool.query(`
        INSERT INTO kyc_reviews (user_id, action, actor, notes, provider, provider_id)
        VALUES ($1, 'submitted', 'user', 'Sessão Didit criada — aguardando verificação', 'didit', $2)
      `, [req.user.id, session.session_id]);

      await logUserAction(req.user.id, 'kyc_submitted', 'user', req.user.id, {
        provider: 'didit', sessionId: session.session_id
      }, req.ip);

      return res.json({
        ok:               true,
        kyc_status:       'submitted',
        provider:         'didit',
        session_id:       session.session_id,
        verification_url: session.verification_url,
        message:          'Redirecionando para verificação de identidade...',
      });
    }

    // Envia para bureau de verificação (stub / serpro)
    const bureauResult = await verifyCPF({
      cpf: cpfValidation.cleaned,
      fullName: full_name.trim(),
      dateOfBirth: date_of_birth
    });

    // Erro de comunicação com o bureau (HTTP 5xx, timeout, etc.)
    if (!bureauResult.ok && !bureauResult.status) {
      logger.error('KYC bureau CPF verification failed', {
        userId: req.user.id,
        bureauError: bureauResult.error
      });
      return res.status(502).json({ error: 'Erro ao verificar CPF. Tente novamente em instantes.' });
    }

    // ── CPF com situação irregular na Receita Federal → rejeição imediata ──────
    // Códigos: suspenso, falecido, cancelado, fraude, nulo, etc.
    // Rejeição automática — mensagem vaga ao usuário (tipping-off prohibition)
    if (bureauResult.status === 'rejected' && bureauResult.rejectionReason !== 'name_mismatch') {
      logger.warn('[KYC] CPF rejeitado pelo bureau — situação irregular', {
        userId: req.user.id,
        cpfMasked: maskCPF(cpfValidation.cleaned),
        reason: bureauResult.rejectionReason,
        provider: bureauResult.provider
      });

      // Salva CPF e rejeita imediatamente
      await pool.query(`
        UPDATE users SET
          cpf = $1,
          full_name = $2,
          date_of_birth = $3,
          kyc_status = 'rejected',
          kyc_submitted_at = NOW(),
          kyc_rejected_at = NOW(),
          kyc_rejection_reason = $4,
          kyc_provider_id = $5
        WHERE id = $6
      `, [
        cpfValidation.cleaned,
        full_name.trim(),
        date_of_birth,
        bureauResult.rejectionReason,
        bureauResult.providerId,
        req.user.id
      ]);

      await pool.query(`
        INSERT INTO kyc_reviews
          (user_id, action, actor, notes, provider, provider_id)
        VALUES ($1, 'rejected', 'bureau', $2, $3, $4)
      `, [
        req.user.id,
        `Rejeitado automaticamente pelo bureau: ${bureauResult.rejectionReason}`,
        bureauResult.provider,
        bureauResult.providerId
      ]);

      await logUserAction(req.user.id, 'kyc_rejected_bureau', 'system', req.user.id, {
        cpfMasked: maskCPF(cpfValidation.cleaned),
        reason: bureauResult.rejectionReason
      }, req.ip);

      return res.status(403).json({
        ok: false,
        kyc_status: KYC_STATUS.REJECTED,
        message: 'Não foi possível verificar sua identidade. Verifique os dados informados e tente novamente.'
      });
    }

    // Salva dados e atualiza status para 'submitted'
    await pool.query(`
      UPDATE users SET
        cpf = $1,
        full_name = $2,
        date_of_birth = $3,
        kyc_status = 'submitted',
        kyc_submitted_at = NOW(),
        kyc_provider_id = $4,
        kyc_rejected_at = NULL,
        kyc_rejection_reason = NULL
      WHERE id = $5
    `, [
      cpfValidation.cleaned,
      full_name.trim(),
      date_of_birth,
      bureauResult.providerId,
      req.user.id
    ]);

    // Registra na tabela de revisões KYC
    await pool.query(`
      INSERT INTO kyc_reviews
        (user_id, action, actor, notes, provider, provider_id)
      VALUES ($1, 'submitted', 'user', 'Dados pessoais enviados pelo usuário', $2, $3)
    `, [req.user.id, bureauResult.provider, bureauResult.providerId]);

    // ── Alerta de nome divergente → revisão manual obrigatória ─────────────────
    // O bureau aprovou o CPF (situação regular) mas o nome declarado não bate
    // com o nome na Receita Federal. Não rejeitamos automaticamente (pode ser
    // abreviação ou nome social), mas inserimos um alerta na fila do admin.
    if (bureauResult.status === 'rejected' && bureauResult.rejectionReason === 'name_mismatch') {
      logger.warn('[KYC] Nome divergente do bureau — requer revisão manual', {
        userId: req.user.id,
        cpfMasked: maskCPF(cpfValidation.cleaned),
        nameScore: bureauResult.rawResponse?.nameScore,
        provider: bureauResult.provider
      });

      await pool.query(`
        INSERT INTO kyc_reviews
          (user_id, action, actor, notes, provider, provider_id)
        VALUES ($1, 'bureau_alert', 'bureau', $2, $3, $4)
      `, [
        req.user.id,
        `ALERTA: Nome declarado diverge do cadastro da Receita Federal (score=${bureauResult.rawResponse?.nameScore ?? '?'}). Revisar antes de aprovar.`,
        bureauResult.provider,
        bureauResult.providerId
      ]);

      await logUserAction(req.user.id, 'kyc_submitted', 'user', req.user.id, {
        cpfMasked: maskCPF(cpfValidation.cleaned),
        bureauProvider: bureauResult.provider,
        alert: 'name_mismatch'
      }, req.ip);

      logger.info('KYC data submitted with name alert — awaiting manual review', {
        userId: req.user.id,
        cpfMasked: maskCPF(cpfValidation.cleaned)
      });

      // Resposta neutra ao usuário — não revelar divergência (tipping-off)
      return res.json({
        ok: true,
        kyc_status: KYC_STATUS.SUBMITTED,
        message: 'Dados enviados com sucesso. Sua identidade está em análise — você será notificado por e-mail em até 24h.'
      });
    }

    await logUserAction(req.user.id, 'kyc_submitted', 'user', req.user.id, {
      cpfMasked: maskCPF(cpfValidation.cleaned),
      bureauProvider: bureauResult.provider
    }, req.ip);

    logger.info('KYC data submitted successfully', {
      userId: req.user.id,
      cpfMasked: maskCPF(cpfValidation.cleaned),
      bureauProvider: bureauResult.provider,
      bureauProviderId: bureauResult.providerId,
      bureauStatus: bureauResult.status
    });

    // Se o bureau aprovou (CPF regular + nome ok), rodar triagem PEP/sanções antes de aprovar
    if (bureauResult.status === 'approved') {
      const screeningResult = await runFullScreening({
        userId: req.user.id,
        cpf: cpfValidation.cleaned,
        fullName: full_name.trim()
      });

      // Sancionado → rejeitar automaticamente
      // Mensagem vaga por lei (Art. 11 Lei 9.613/98 — proibição de tipping-off)
      if (screeningResult.sanctionsResult.isSanctioned) {
        await pool.query(`
          UPDATE users SET
            kyc_status = 'rejected',
            kyc_rejected_at = NOW(),
            kyc_rejection_reason = 'sanctions_match',
            kyc_approved_at = NULL
          WHERE id = $1
        `, [req.user.id]);

        await pool.query(`
          INSERT INTO kyc_reviews
            (user_id, action, actor, notes)
          VALUES ($1, 'rejected', 'system', 'Rejeitado automaticamente: match em lista de sanções internacionais')
        `, [req.user.id]);

        logger.warn('[KYC] Usuário rejeitado por match em lista de sanções', {
          userId: req.user.id,
          lists: screeningResult.sanctionsResult.lists
        });

        return res.status(403).json({
          ok: false,
          kyc_status: KYC_STATUS.REJECTED,
          message: 'Verificação de identidade não aprovada.'
        });
      }

      // PEP → manter 'submitted', aguardar revisão manual do admin
      // Mesma mensagem do fluxo normal — não revelar ao usuário que é PEP
      if (screeningResult.pepResult.isPep) {
        await pool.query(`
          INSERT INTO kyc_reviews
            (user_id, action, actor, notes)
          VALUES ($1, 'pep_flagged', 'system', 'PEP identificado — aguardando revisão manual do administrador')
        `, [req.user.id]);

        logger.warn('[KYC] PEP identificado — requer revisão manual do admin', {
          userId: req.user.id,
          confidence: screeningResult.pepResult.confidence,
          matchedKeywords: screeningResult.pepResult.details?.matchedKeywords
        });

        return res.json({
          ok: true,
          kyc_status: KYC_STATUS.SUBMITTED,
          message: 'Dados enviados com sucesso. Sua identidade está em análise — você será notificado por e-mail em até 24h.'
        });
      }

      // Clear → aprovar automaticamente
      await pool.query(`
        UPDATE users SET kyc_status = 'approved', kyc_approved_at = NOW()
        WHERE id = $1
      `, [req.user.id]);

      await pool.query(`
        INSERT INTO kyc_reviews
          (user_id, action, actor, notes, provider, provider_id)
        VALUES ($1, 'approved', 'bureau', 'Aprovado automaticamente pelo bureau — triagem PEP/sanções: clear', $2, $3)
      `, [req.user.id, bureauResult.provider, bureauResult.providerId]);

      return res.json({
        ok: true,
        kyc_status: KYC_STATUS.APPROVED,
        message: 'Identidade verificada com sucesso! Você já pode operar.'
      });
    }

    res.json({
      ok: true,
      kyc_status: KYC_STATUS.SUBMITTED,
      message: 'Dados enviados com sucesso. Sua identidade está em análise — você será notificado por e-mail em até 24h.'
    });
  } catch (err) {
    // Erro de conectividade com o bureau (Serpro inacessível, credenciais inválidas, etc.)
    if (err.message === 'bureau_unreachable' || err.isNetworkError) {
      logger.error('KYC submit error — bureau inacessível', { userId: req.user.id, provider: process.env.BUREAU_PROVIDER });
      return res.status(502).json({
        error: 'Serviço de verificação temporariamente indisponível. Tente novamente em alguns minutos.'
      });
    }
    logger.error('KYC submit error', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /kyc/document
 * Registra referência de documento enviado pelo frontend.
 * Body: { document_type: 'rg'|'cnh'|'rne', front_url, back_url, selfie_url }
 */
router.post('/document', auth, async (req, res) => {
  try {
    const { document_type, front_url, back_url, selfie_url } = req.body;

    const validTypes = ['rg', 'cnh', 'rne', 'passaporte'];
    if (!validTypes.includes(document_type)) {
      return res.status(400).json({ error: 'Tipo de documento inválido. Use: rg, cnh, rne ou passaporte' });
    }
    if (!front_url) {
      return res.status(400).json({ error: 'Imagem frontal do documento é obrigatória' });
    }

    const bureauResult = await verifyDocument({
      userId: req.user.id,
      documentType: document_type,
      documentFront: front_url,
      documentBack: back_url,
      selfie: selfie_url
    });

    // Salva referências de documento
    await pool.query(`
      INSERT INTO kyc_reviews
        (user_id, action, actor, notes, provider, provider_id)
      VALUES ($1, 'document_submitted', 'user', $2, $3, $4)
    `, [
      req.user.id,
      JSON.stringify({ document_type, has_back: !!back_url, has_selfie: !!selfie_url }),
      bureauResult.provider,
      bureauResult.providerId
    ]);

    await logUserAction(req.user.id, 'kyc_document_submitted', 'user', req.user.id, {
      documentType: document_type
    }, req.ip);

    logger.info('KYC document submitted', {
      userId: req.user.id,
      documentType: document_type,
      bureauProvider: bureauResult.provider
    });

    res.json({
      ok: true,
      message: 'Documento enviado com sucesso. Aguarde a análise.'
    });
  } catch (err) {
    logger.error('KYC document error', { userId: req.user.id, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── DIDIT ROUTES ─────────────────────────────────────────────────────────────

/**
 * POST /kyc/didit/webhook
 * Recebe notificações assíncronas do Didit sobre o resultado da verificação.
 * Sem autenticação JWT — validado via assinatura HMAC.
 */
router.post('/didit/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-signature-v2'];
    const timestamp = req.headers['x-timestamp'];
    const rawBody   = req.body;

    // Verificar assinatura
    if (!verifyWebhookSignature(rawBody, signature, timestamp)) {
      logger.warn('[DIDIT-WEBHOOK] Assinatura inválida rejeitada');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload   = JSON.parse(rawBody.toString());
    const { session_id, status, vendor_data } = payload;
    // vendor_data é o UUID do usuário (String) — nunca usar parseInt
    const userId    = vendor_data ? String(vendor_data).trim() : null;

    logger.info('[DIDIT-WEBHOOK] Recebido', { session_id, status, userId });

    if (!userId) {
      logger.warn('[DIDIT-WEBHOOK] vendor_data inválido', { vendor_data });
      return res.json({ received: true });
    }

    const kycStatus = mapDiditStatus(status);

    if (kycStatus === 'approved') {
      await pool.query(`
        UPDATE users SET
          kyc_status = 'approved',
          kyc_approved_at = NOW(),
          kyc_provider_id = $1,
          kyc_rejected_at = NULL,
          kyc_rejection_reason = NULL
        WHERE id = $2
      `, [session_id, userId]);

      await pool.query(`
        INSERT INTO kyc_reviews (user_id, action, actor, notes, provider, provider_id)
        VALUES ($1, 'approved', 'bureau', 'Aprovado automaticamente pelo Didit — verificação de documento concluída', 'didit', $2)
      `, [userId, session_id]);

      // Rodar triagem PEP após aprovação Didit
      try {
        const userRow = await pool.query('SELECT cpf, full_name FROM users WHERE id = $1', [userId]);
        if (userRow.rows[0]?.cpf) {
          const screening = await runFullScreening({
            userId,
            cpf:      userRow.rows[0].cpf,
            fullName: userRow.rows[0].full_name,
          });

          if (screening.pepResult.isPep) {
            await pool.query(`UPDATE users SET kyc_status = 'submitted' WHERE id = $1`, [userId]);
            await pool.query(`
              INSERT INTO kyc_reviews (user_id, action, actor, notes)
              VALUES ($1, 'pep_flagged', 'system', 'PEP identificado via triagem pós-Didit — aguarda revisão manual')
            `, [userId]);
          }
        }
      } catch (pepErr) {
        logger.error('[DIDIT-WEBHOOK] Erro na triagem PEP pós-aprovação', { userId, error: pepErr.message });
      }

      logger.info('[DIDIT-WEBHOOK] KYC aprovado', { userId, session_id });

    } else if (kycStatus === 'rejected') {
      await pool.query(`
        UPDATE users SET
          kyc_status = 'rejected',
          kyc_rejected_at = NOW(),
          kyc_rejection_reason = 'didit_declined',
          kyc_provider_id = $1
        WHERE id = $2
      `, [session_id, userId]);

      await pool.query(`
        INSERT INTO kyc_reviews (user_id, action, actor, notes, provider, provider_id)
        VALUES ($1, 'rejected', 'bureau', 'Rejeitado pelo Didit — verificação de documento não aprovada', 'didit', $2)
      `, [userId, session_id]);

      logger.warn('[DIDIT-WEBHOOK] KYC rejeitado', { userId, session_id, diditStatus: status });

    } else {
      // In Review, In Progress etc — manter submitted
      logger.info('[DIDIT-WEBHOOK] Status intermediário, nenhuma ação', { userId, status, kycStatus });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('[DIDIT-WEBHOOK] Erro no processamento', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /kyc/didit/session/:sessionId
 * Polling: consulta o status de uma sessão Didit (para o frontend verificar após retorno).
 */
router.get('/didit/session/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const decision = await getSessionDecision(sessionId);
    const kycStatus = mapDiditStatus(decision.status);

    res.json({
      ok:         true,
      session_id: sessionId,
      didit_status: decision.status,
      kyc_status: kycStatus,
    });
  } catch (err) {
    logger.error('[DIDIT] Erro ao consultar sessão', { error: err.message });
    res.status(500).json({ error: 'Erro ao consultar sessão Didit' });
  }
});

// ── ADMIN ROUTES ─────────────────────────────────────────────────────────────

/**
 * GET /kyc/admin/approved
 * Lista usuários com KYC aprovado, ordenados por data de aprovação.
 */
router.get('/admin/approved', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.full_name,
        u.cpf,
        u.date_of_birth,
        u.kyc_status,
        u.kyc_approved_at,
        u.kyc_provider_id,
        u.pep_status,
        u.sanctions_status
      FROM users u
      WHERE u.kyc_status = 'approved'
        AND COALESCE(u.is_bot, FALSE) = FALSE
      ORDER BY u.kyc_approved_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, count: result.rows.length, users: result.rows });
  } catch (err) {
    logger.error('KYC admin approved list error', { error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /kyc/admin/pending
 * Lista usuários com KYC em análise (submitted).
 */
router.get('/admin/pending', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.full_name,
        u.cpf,
        u.date_of_birth,
        u.kyc_status,
        u.kyc_submitted_at,
        u.kyc_provider_id,
        u.pep_status,
        u.pep_checked_at,
        u.sanctions_status,
        u.created_at,
        (SELECT COUNT(*) FROM kyc_reviews kr WHERE kr.user_id = u.id) AS review_count,
        -- Verifica se existe alerta de nome divergente do bureau
        EXISTS (
          SELECT 1 FROM kyc_reviews kr
          WHERE kr.user_id = u.id AND kr.action = 'bureau_alert'
        ) AS has_bureau_alert,
        -- Busca a nota do alerta mais recente para exibir no painel
        (
          SELECT kr.notes FROM kyc_reviews kr
          WHERE kr.user_id = u.id AND kr.action = 'bureau_alert'
          ORDER BY kr.created_at DESC LIMIT 1
        ) AS bureau_alert_notes
      FROM users u
      WHERE u.kyc_status = 'submitted'
      ORDER BY has_bureau_alert DESC, u.pep_status DESC, u.kyc_submitted_at ASC
    `);

    res.json({ ok: true, count: result.rows.length, users: result.rows });
  } catch (err) {
    logger.error('KYC admin pending list error', { error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /kyc/admin/:userId/approve
 * Aprova o KYC de um usuário.
 */
router.post('/admin/:userId/approve', adminAuth, async (req, res) => {
  const { userId } = req.params;
  const { notes } = req.body;

  try {
    const user = await pool.query(
      'SELECT id, username, email, kyc_status FROM users WHERE id = $1',
      [userId]
    );
    if (!user.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    if (user.rows[0].kyc_status === 'approved') {
      return res.status(400).json({ error: 'KYC já aprovado' });
    }

    await pool.query(`
      UPDATE users SET
        kyc_status = 'approved',
        kyc_approved_at = NOW(),
        kyc_rejected_at = NULL,
        kyc_rejection_reason = NULL
      WHERE id = $1
    `, [userId]);

    await pool.query(`
      INSERT INTO kyc_reviews
        (user_id, action, actor, notes)
      VALUES ($1, 'approved', 'admin', $2)
    `, [userId, notes || 'Aprovado pelo administrador']);

    logger.info('KYC approved by admin', {
      targetUserId: userId,
      username: user.rows[0].username,
      notes
    });

    res.json({
      ok: true,
      message: `KYC aprovado para ${user.rows[0].username}`
    });
  } catch (err) {
    logger.error('KYC admin approve error', { userId, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /kyc/admin/:userId/reject
 * Rejeita o KYC de um usuário.
 * Body: { reason: string }
 */
router.post('/admin/:userId/reject', adminAuth, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Motivo da rejeição é obrigatório' });
  }

  try {
    const user = await pool.query(
      'SELECT id, username, kyc_status FROM users WHERE id = $1',
      [userId]
    );
    if (!user.rows.length) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    await pool.query(`
      UPDATE users SET
        kyc_status = 'rejected',
        kyc_rejected_at = NOW(),
        kyc_rejection_reason = $1,
        kyc_approved_at = NULL
      WHERE id = $2
    `, [reason, userId]);

    await pool.query(`
      INSERT INTO kyc_reviews
        (user_id, action, actor, notes)
      VALUES ($1, 'rejected', 'admin', $2)
    `, [userId, `Motivo: ${reason}`]);

    logger.warn('KYC rejected by admin', {
      targetUserId: userId,
      username: user.rows[0].username,
      reason
    });

    res.json({ ok: true, message: `KYC rejeitado para ${user.rows[0].username}` });
  } catch (err) {
    logger.error('KYC admin reject error', { userId, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /kyc/admin/coaf-flags
 * Lista flags COAF pendentes de revisão.
 */
router.get('/admin/coaf-flags', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        cf.id,
        cf.user_id,
        u.username,
        u.email,
        u.full_name,
        cf.month_total,
        cf.status,
        cf.created_at,
        cf.resolved_at,
        cf.resolution_notes
      FROM coaf_flags cf
      JOIN users u ON u.id = cf.user_id
      WHERE cf.status = 'pending'
      ORDER BY cf.created_at DESC
    `);

    res.json({ ok: true, count: result.rows.length, flags: result.rows });
  } catch (err) {
    logger.error('COAF flags list error', { error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /kyc/admin/coaf-flags/:id/resolve
 * Resolve (descarta ou reporta) um flag COAF.
 * Body: { action: 'dismissed'|'reported', notes: string }
 */
router.post('/admin/coaf-flags/:id/resolve', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { action, notes } = req.body;

  if (!['dismissed', 'reported'].includes(action)) {
    return res.status(400).json({ error: 'action deve ser "dismissed" ou "reported"' });
  }

  try {
    await pool.query(`
      UPDATE coaf_flags SET
        status = $1,
        resolution_notes = $2,
        resolved_at = NOW()
      WHERE id = $3
    `, [action, notes || '', id]);

    logger.info('COAF flag resolved', { flagId: id, action, notes });
    res.json({ ok: true, message: `Flag COAF ${action === 'reported' ? 'reportado ao COAF' : 'descartado'}` });
  } catch (err) {
    logger.error('COAF flag resolve error', { id, error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /kyc/admin/pep
 * Lista usuários com pep_status = 'flagged' aguardando revisão manual.
 * Usa LATERAL JOIN para buscar apenas o registro PEP mais recente por usuário.
 */
router.get('/admin/pep', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.full_name,
        u.kyc_status,
        u.kyc_submitted_at,
        u.pep_status,
        u.pep_checked_at,
        u.sanctions_status,
        pr.confidence,
        pr.source,
        pr.details AS pep_details,
        pr.created_at AS screened_at
      FROM users u
      LEFT JOIN LATERAL (
        SELECT confidence, source, details, created_at
        FROM pep_reviews
        WHERE user_id = u.id
          AND screening_type = 'pep'
          AND result = 'flagged'
        ORDER BY created_at DESC
        LIMIT 1
      ) pr ON TRUE
      WHERE u.pep_status = 'flagged'
        AND COALESCE(u.is_bot, FALSE) = FALSE
      ORDER BY u.pep_checked_at DESC
    `);

    res.json({ ok: true, count: result.rows.length, users: result.rows });
  } catch (err) {
    logger.error('KYC admin PEP list error', { error: err.message });
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

module.exports = router;
