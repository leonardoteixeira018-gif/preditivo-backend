function fmtMoney(value) {
  return 'R$' + parseFloat(value || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtInt(value) {
  return parseInt(value || 0, 10).toLocaleString('pt-BR');
}

function curateOpenMarkets() {
  if (!confirm('Atualizar regras e datas dos mercados abertos mapeados?\n\nIsso sobrescreve descricoes e vencimentos desses mercados.')) return;
  showToast('Ajustando mercados...');
  fetch(API + '/admin/markets/curate', { method: 'POST', headers: adminHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        showToast('Erro: ' + d.error);
        return;
      }
      showToast((d.updated_count || 0) + ' mercados ajustados');
      if (typeof loadMarkets === 'function') loadMarkets();
    })
    .catch(function() { showToast('Erro ao ajustar mercados'); });
}

function runTechSimulation() {
  var roundsInput = document.getElementById('simRounds');
  var rounds = parseInt(roundsInput && roundsInput.value, 10) || 50;
  if (rounds < 1) rounds = 1;
  if (rounds > 500) rounds = 500;

  var result = document.getElementById('botSimResult');
  if (result) {
    result.textContent = 'Simulando apostas em mercados tech...';
    result.style.color = '#5a6878';
  }

  fetch(API + '/admin/bots/simulate', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ rounds: rounds, category: 'tech' })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!result) return;
      if (d.error) {
        result.textContent = 'Erro: ' + d.error;
        result.style.color = '#ff4757';
        return;
      }
      result.textContent = 'Tech: ' + d.bets_placed + ' apostas | ' + fmtMoney(d.volume || 0) + ' vol';
      result.style.color = '#00e676';
      if (typeof loadBotStats === 'function') loadBotStats();
      if (typeof loadMarkets === 'function') loadMarkets();
    })
    .catch(function() {
      if (!result) return;
      result.textContent = 'Erro ao simular tech';
      result.style.color = '#ff4757';
    });
}

function ensureEnhancementPanels() {
  var secBots = document.getElementById('sec-bots');
  if (secBots && !document.getElementById('botConfigPanel')) {
    var controlsAnchor = secBots.querySelector('.simulate-row');
    if (controlsAnchor) {
      var botConfigPanel = document.createElement('div');
      botConfigPanel.id = 'botConfigPanel';
      botConfigPanel.style.cssText = 'background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:18px;margin:18px 0;';
      botConfigPanel.innerHTML = '' +
        '<div class="section-title" style="font-size:0.95rem;margin-bottom:12px">Controle do bot automatico</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">' +
        '<div><div class="form-label">Apostas por ciclo</div><input id="botRoundsPerCycle" class="form-input" type="number" min="1" max="500" style="width:140px"></div>' +
        '<div><div class="form-label">Aposta minima</div><input id="botMinAmount" class="form-input" type="number" min="1" step="1" style="width:140px"></div>' +
        '<div><div class="form-label">Aposta maxima</div><input id="botMaxAmount" class="form-input" type="number" min="1" step="1" style="width:140px"></div>' +
        '<div><div class="form-label">Categoria auto</div><select id="botAutoCategory" class="form-select" style="width:160px"><option value="">Todas</option><option value="politica">Politica</option><option value="economia">Economia</option><option value="futebol">Futebol</option><option value="tech">Tech</option></select></div>' +
        '<button class="btn btn-green" onclick="saveBotConfig()">Salvar config</button>' +
        '</div>' +
        '<div id="botConfigStatus" style="margin-top:10px;font-size:0.85rem;color:#5a6878"></div>';
      controlsAnchor.parentNode.insertBefore(botConfigPanel, controlsAnchor);

      var realPanel = document.createElement('div');
      realPanel.id = 'realUsersPanel';
      realPanel.style.cssText = 'background:#0e1419;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:18px;margin-top:24px;';
      realPanel.innerHTML = '' +
        '<div class="section-title" style="font-size:0.95rem;margin-bottom:12px">Painel real</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">' +
        '<div class="receita-card"><div class="receita-label">Usuarios reais</div><div class="receita-val" id="realUserCount">-</div></div>' +
        '<div class="receita-card"><div class="receita-label">Apostas exibidas</div><div class="receita-val" id="realDisplayBets">-</div></div>' +
        '<div class="receita-card"><div class="receita-label">Lucro exibido</div><div class="receita-val" id="realDisplayProfit">-</div></div>' +
        '<div class="receita-card"><div class="receita-label">Precisao media</div><div class="receita-val" id="realAvgWinRate">-</div></div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn btn-resolve" onclick="randomizeRealRanking()">Randomizar ranking real</button>' +
        '<span id="realPanelStatus" style="font-size:0.85rem;color:#5a6878"></span>' +
        '</div>' +
        '<div style="margin-top:16px"><table><thead><tr><th>Usuario</th><th>Apostas</th><th>Lucro</th><th>Precisao</th></tr></thead><tbody id="realPreviewTbody"><tr><td colspan="4" style="text-align:center;padding:20px;color:#5a6878">Carregando...</td></tr></tbody></table></div>';
      secBots.appendChild(realPanel);
    }
  }
}

function loadBotConfig() {
  fetch(API + '/admin/bots/config', { headers: adminHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(config) {
      if (config.error) return;
      var roundsEl = document.getElementById('botRoundsPerCycle');
      var minEl = document.getElementById('botMinAmount');
      var maxEl = document.getElementById('botMaxAmount');
      var categoryEl = document.getElementById('botAutoCategory');
      if (roundsEl) roundsEl.value = config.rounds_per_cycle || 5;
      if (minEl) minEl.value = config.min_amount || 5;
      if (maxEl) maxEl.value = config.max_amount || 800;
      if (categoryEl) categoryEl.value = config.category || '';
      var statusEl = document.getElementById('botConfigStatus');
      if (statusEl) statusEl.textContent = 'Auto: ' + (config.enabled ? 'ativo' : 'inativo');
    })
    .catch(function() {});
}

function saveBotConfig() {
  var rounds = parseInt(document.getElementById('botRoundsPerCycle').value, 10) || 5;
  var minAmount = parseFloat(document.getElementById('botMinAmount').value) || 5;
  var maxAmount = parseFloat(document.getElementById('botMaxAmount').value) || 800;
  var category = document.getElementById('botAutoCategory').value || null;
  var statusEl = document.getElementById('botConfigStatus');
  statusEl.textContent = 'Salvando...';

  fetch(API + '/admin/bots/config', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      rounds_per_cycle: rounds,
      min_amount: minAmount,
      max_amount: maxAmount,
      category: category
    })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        statusEl.textContent = 'Erro: ' + d.error;
        statusEl.style.color = '#ff4757';
        return;
      }
      statusEl.textContent = 'Configuracao salva';
      statusEl.style.color = '#00e676';
      if (typeof loadBotStats === 'function') loadBotStats();
    })
    .catch(function() {
      statusEl.textContent = 'Erro ao salvar';
      statusEl.style.color = '#ff4757';
    });
}

function loadRealPanel() {
  fetch(API + '/admin/real/stats', { headers: adminHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) return;
      var totals = d.totals || {};
      var countEl = document.getElementById('realUserCount');
      var betsEl = document.getElementById('realDisplayBets');
      var profitEl = document.getElementById('realDisplayProfit');
      var rateEl = document.getElementById('realAvgWinRate');
      if (countEl) countEl.textContent = fmtInt(totals.total_users);
      if (betsEl) betsEl.textContent = fmtInt(totals.display_bets);
      if (profitEl) profitEl.textContent = fmtMoney(totals.display_profit);
      if (rateEl) rateEl.textContent = parseFloat(totals.avg_win_rate || 0).toFixed(1) + '%';

      var tbody = document.getElementById('realPreviewTbody');
      if (!tbody) return;
      if (!d.preview || !d.preview.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:#5a6878">Sem usuarios reais</td></tr>';
        return;
      }
      tbody.innerHTML = d.preview.map(function(row) {
        return '<tr>' +
          '<td>' + row.username + '</td>' +
          '<td>' + fmtInt(row.total_bets) + '</td>' +
          '<td style="color:#00e676">' + fmtMoney(row.total_profit) + '</td>' +
          '<td style="color:#00b4ff">' + parseFloat(row.win_rate || 0).toFixed(1) + '%</td>' +
          '</tr>';
      }).join('');
    })
    .catch(function() {});
}

function randomizeRealRanking() {
  var statusEl = document.getElementById('realPanelStatus');
  if (statusEl) {
    statusEl.textContent = 'Randomizando ranking...';
    statusEl.style.color = '#5a6878';
  }

  fetch(API + '/admin/real/randomize-ranking', { method: 'POST', headers: adminHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        if (statusEl) {
          statusEl.textContent = 'Erro: ' + d.error;
          statusEl.style.color = '#ff4757';
        }
        return;
      }
      if (statusEl) {
        statusEl.textContent = fmtInt(d.updated) + ' usuarios atualizados';
        statusEl.style.color = '#00e676';
      }
      loadRealPanel();
    })
    .catch(function() {
      if (statusEl) {
        statusEl.textContent = 'Erro ao randomizar';
        statusEl.style.color = '#ff4757';
      }
    });
}

function enhanceReceitaRenderer() {
  window.loadReceita = function() {
    fetch(API + '/admin/receita', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) return;
        var house = d.casa || {};
        var real = d.usuarios_reais || {};
        var artificial = d.usuarios_artificiais || {};

        var html = '' +
          '<div class="section-title" style="margin-top:0">Casa</div>' +
          '<div class="receita-grid">' +
          '<div class="receita-card"><div class="receita-label">Receita bruta</div><div class="receita-val" style="color:#ffc107">' + fmtMoney(house.receita_bruta) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Taxa coletada</div><div class="receita-val" style="color:#00e676">' + fmtMoney(house.taxa_coletada) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Spread retido</div><div class="receita-val" style="color:#00b4ff">' + fmtMoney(house.spread_retido) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Total depositado</div><div class="receita-val">' + fmtMoney(house.total_depositado) + '</div></div>' +
          '</div>' +
          '<div class="section-title" style="margin-top:16px">Usuarios reais</div>' +
          '<div class="receita-grid">' +
          '<div class="receita-card"><div class="receita-label">Total apostado</div><div class="receita-val">' + fmtMoney(real.total_apostado) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Total recebido</div><div class="receita-val" style="color:#00e676">' + fmtMoney(real.total_pago) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Lucro liquido</div><div class="receita-val" style="color:#00b4ff">' + fmtMoney(real.lucro_liquido) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Taxa paga</div><div class="receita-val" style="color:#ffc107">' + fmtMoney(real.taxa_coletada) + '</div></div>' +
          '</div>' +
          '<div class="section-title" style="margin-top:16px">Artificial</div>' +
          '<div class="receita-grid">' +
          '<div class="receita-card"><div class="receita-label">Total apostado</div><div class="receita-val">' + fmtMoney(artificial.total_apostado) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Total recebido</div><div class="receita-val" style="color:#00e676">' + fmtMoney(artificial.total_pago) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Lucro liquido</div><div class="receita-val" style="color:#00b4ff">' + fmtMoney(artificial.lucro_liquido) + '</div></div>' +
          '<div class="receita-card"><div class="receita-label">Taxa paga</div><div class="receita-val" style="color:#ffc107">' + fmtMoney(artificial.taxa_coletada) + '</div></div>' +
          '</div>';

        if (d.por_mercado && d.por_mercado.length) {
          html += '<div class="section-title" style="margin-top:8px">Por Mercado</div>';
          html += '<table><thead><tr><th>Mercado</th><th>Apostado</th><th>Taxa 2%</th><th>Status</th></tr></thead><tbody>';
          html += d.por_mercado.map(function(m) {
            return '<tr>' +
              '<td>' + m.title + '</td>' +
              '<td>' + fmtMoney(m.total_apostado) + '</td>' +
              '<td style="color:#00e676">' + fmtMoney(m.taxa_coletada) + '</td>' +
              '<td>' + (m.resolved_outcome ? m.resolved_outcome.toUpperCase() : 'ABERTO') + '</td>' +
              '</tr>';
          }).join('');
          html += '</tbody></table>';
        }

        document.getElementById('receitaContent').innerHTML = html;
      })
      .catch(function(e) { console.error(e); });
  };
}

function enhanceBotStatsLoader() {
  var original = window.loadBotStats;
  window.loadBotStats = function() {
    if (typeof original === 'function') original();
    loadBotConfig();
    loadRealPanel();
  };
}

function enhanceBotControls() {
  var originalEnable = window.enableBot;
  window.enableBot = function() {
    if (typeof originalEnable === 'function') originalEnable();
    setTimeout(loadBotConfig, 400);
  };

  var originalDisable = window.disableBot;
  window.disableBot = function() {
    if (typeof originalDisable === 'function') originalDisable();
    setTimeout(loadBotConfig, 400);
  };

  var originalReload = window.reloadAllBotBalances;
  window.reloadAllBotBalances = function() {
    fetch(API + '/admin/users', { headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(users) {
        var amount = parseFloat(document.getElementById('botReloadAmount').value);
        if (!amount || amount < 0) { showToast('Digite um valor valido'); return; }

        var btn = document.getElementById('botReloadBtn');
        var statusEl = document.getElementById('botReloadStatus');
        btn.disabled = true;
        btn.textContent = 'Carregando...';
        statusEl.textContent = 'Buscando usuarios...';

        var botUsers = users.filter(function(u) { return !!u.is_bot; });
        statusEl.textContent = 'Encontrados ' + botUsers.length + ' bots. Atualizando saldos...';

        return Promise.all(botUsers.map(function(u) {
          return fetch(API + '/admin/balance', {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ user_id: u.id, amount: amount })
          }).then(function(r) { return r.json(); });
        })).then(function(results) {
          var ok = results.filter(function(x) { return !x.error; }).length;
          statusEl.textContent = ok + '/' + botUsers.length + ' bots atualizados para ' + fmtMoney(amount);
          statusEl.style.color = '#00e676';
          showToast('Saldo de ' + ok + ' bots atualizado!');
          if (typeof loadBotStats === 'function') loadBotStats();
        }).finally(function() {
          btn.disabled = false;
          btn.textContent = 'Recarregar Saldo de Todos os Bots';
        });
      })
      .catch(function(err) {
        console.error(err);
        if (typeof originalReload === 'function') originalReload();
      });
  };
}

document.addEventListener('DOMContentLoaded', function() {
  var marketActions = document.querySelector('#sec-markets div[style*="display:flex"][style*="gap:8px"]');
  if (marketActions && !marketActions.querySelector('[onclick="curateOpenMarkets()"]')) {
    var curateBtn = document.createElement('button');
    curateBtn.className = 'btn btn-resolve';
    curateBtn.textContent = 'Ajustar regras & datas';
    curateBtn.onclick = curateOpenMarkets;
    marketActions.insertBefore(curateBtn, marketActions.firstChild);
  }
});

window.addEventListener('load', function() {
  ensureEnhancementPanels();
  enhanceReceitaRenderer();
  enhanceBotStatsLoader();
  enhanceBotControls();
  loadBotConfig();
  loadRealPanel();
});
