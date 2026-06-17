const express = require('express');
const axios = require('axios');
const mqtt = require('mqtt');
const { google } = require('googleapis');
const path = require('path');
const cookieParser = require('cookie-parser');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get('/', (req, res, next) => {
    if (req.query.id) return res.redirect('/app/' + req.query.id);
    next();
});

app.use(express.static('public'));

const MASTER_SHEET_ID = "19427ddGD6PLr38I_hELCd6OhA89UycUyTNt-h7Exb8I";
let CLIENTES = {}; 
let STATUS_CACHE = {};
let INTENTS_ATIVOS = {};
let CACHE_DADOS_MAQUINAS = {}; 

function getGoogleAuth() {
    return new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'], 
    });
}

// 🔥 MARRETA EXTREMA CALIBRADA: Força o Android da maquininha a alternar de modo e abrir a tela certa
async function aplicarMarretaExtrema(deviceId, token) {
    try {
        console.log(`[MARRETA] Forçando modo STANDALONE no dispositivo ${deviceId}...`);
        await axios.patch(`https://api.mercadopago.com/point/integration-api/devices/${deviceId}`, { operating_mode: "STANDALONE" }, { headers: { 'Authorization': `Bearer ${token}` } });
        
        // ⏱️ Tempo de respiro para a nuvem do Mercado Pago processar a desconexão
        await new Promise(r => setTimeout(r, 5000)); 
        
        console.log(`[MARRETA] Forçando retorno para o modo PDV...`);
        await axios.patch(`https://api.mercadopago.com/point/integration-api/devices/${deviceId}`, { operating_mode: "PDV" }, { headers: { 'Authorization': `Bearer ${token}` } });
        
        // ⏱️ Tempo para a interface física da maquininha atualizar e carregar o app em primeiro plano
        await new Promise(r => setTimeout(r, 5000)); 
        
        console.log(`[MARRETA EXTREMA] Sincronização de tela concluída com sucesso!`);
    } catch (e) {
        console.log(`[MARRETA EXTREMA] Falha na sincronização do dispositivo ${deviceId}:`, e.message);
    }
}

async function forcarCancelamentoMP(deviceId, intentId, token) {
    try {
        await axios.delete(`https://api.mercadopago.com/point/integration-api/payment-intents/${intentId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        return true;
    } catch (e1) {
        try {
            await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${deviceId}/payment-intents/${intentId}`, { headers: { 'Authorization': `Bearer ${token}` } });
            return true;
        } catch (e2) {
            console.log(`[MP BLOQUEOU] Não foi possível cancelar (ON_TERMINAL). O hardware fará o timeout natural.`);
            return false;
        }
    }
}

async function carregarConfiguracoes() {
    try {
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: 'CONFIG_GERAL!A:F' });
        const linhas = response.data.values;
        if (linhas && linhas.length > 1) { // Corrigido o erro de digitação para "linhas" aqui!
            CLIENTES = {}; 
            for (let i = 1; i < linhas.length; i++) {
                const [id, dono, token, sheet, maquininha, deviceId] = linhas[i];
                if (id && dono) {
                    CLIENTES[id.trim()] = { dono: dono.trim(), token_mp: token ? token.trim() : "", sheet_id: sheet ? sheet.trim() : "", usa_maquininha: maquininha && String(maquininha).trim().toUpperCase() === "SIM", device_id: deviceId ? deviceId.trim() : "" };
                }
            }
        }
    } catch (err) {}
}

async function sincronizarPrecosPlanilhas() {
    const sheetsUnicas = [...new Set(Object.values(CLIENTES).map(c => c.sheet_id).filter(id => id))];
    for (let sheetId of sheetsUnicas) {
        try {
            const auth = getGoogleAuth();
            const sheets = google.sheets({ version: 'v4', auth });
            const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A:Z' });
            const linhas = response.data.values;
            if (!linhas || linhas.length === 0) continue;
            
            const cabecalho = linhas[0];
            const colTempo = cabecalho.findIndex(c => c && (c.trim() === 'Tempo do Ciclo' || c.trim() === 'Tempo Padrão'));
            const colLavar = cabecalho.findIndex(c => c && (c.trim() === 'Preço_lavar' || c.trim() === 'Preço Padrão' || c.trim() === 'preco_45'));
            const colSecar = cabecalho.findIndex(c => c && (c.trim() === 'preco_secar' || c.trim() === 'Preço Secar'));
            const colPrecoPromo = cabecalho.findIndex(c => c && c.trim() === 'Preço Promoção');
            const colDiaPromo = cabecalho.findIndex(c => c && c.trim() === 'Dia da Promoção');
            const colHoraInicio = cabecalho.findIndex(c => c && c.trim() === 'Hora Início');
            const colHoraFim = cabecalho.findIndex(c => c && c.trim() === 'Hora Fim');

            for (let i = 1; i < linhas.length; i++) {
                let idMaq = linhas[i][0];
                if (!idMaq) continue; idMaq = idMaq.trim();
                let pLavar = colLavar !== -1 && linhas[i][colLavar] ? linhas[i][colLavar].toString().replace('R$', '').replace(',', '.').trim() : "0";
                let pSecar = colSecar !== -1 && linhas[i][colSecar] ? linhas[i][colSecar].toString().replace('R$', '').replace(',', '.').trim() : "0";
                let tCiclo = colTempo !== -1 && linhas[i][colTempo] ? linhas[i][colTempo].toString().trim() : "45";
                let pPromo = colPrecoPromo !== -1 && linhas[i][colPrecoPromo] ? linhas[i][colPrecoPromo].toString().trim() : "";
                let dPromo = colDiaPromo !== -1 && linhas[i][colDiaPromo] ? linhas[i][colDiaPromo].toString().trim() : "";
                let hInicio = colHoraInicio !== -1 && linhas[i][colHoraInicio] ? linhas[i][colHoraInicio].toString().trim() : "";
                let hFim = colHoraFim !== -1 && linhas[i][colHoraFim] ? linhas[i][colHoraFim].toString().trim() : "";
                CACHE_DADOS_MAQUINAS[idMaq] = { preco_lavar: pLavar, preco_secar: pSecar, tempo: tCiclo, preco_promo: pPromo, dia_promo: dPromo, hora_inicio: hInicio, hora_fim: hFim };
            }
        } catch (err) {}
    }
}

carregarConfiguracoes();
setInterval(carregarConfiguracoes, 600000); 
setTimeout(sincronizarPrecosPlanilhas, 5000); 
setInterval(sincronizarPrecosPlanilhas, 120000);

async function buscarDadosNaPlanilha(sheetId, idMaquina, colunaPreco) {
    let dados = CACHE_DADOS_MAQUINAS[idMaquina];
    if (!dados) return { preco: "0", tempo: "45" }; 
    let precoCerto = colunaPreco.includes('sec') ? dados.preco_secar : dados.preco_lavar;
    return { preco: precoCerto, tempo: dados.tempo };
}

async function autenticarUsuarioNaPlanilha(usuario, senha) {
    try {
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SHEET_ID, range: 'Login!A:C' });
        const linhas = response.data.values;
        if (!linhas) return null;
        const header = linhas[0];
        const colUser = header.findIndex(h => h.trim() === 'usuario_login');
        const colPass = header.findIndex(h => h.trim() === 'senha_acesso');
        const colDono = header.findIndex(h => h.trim() === 'dono');
        const linhaUsuario = linhas.find(row => row[colUser] && row[colUser].trim() === usuario.trim() && row[colPass] && String(row[colPass]).trim() === String(senha).trim());
        return linhaUsuario ? linhaUsuario[colDono].trim() : null;
    } catch (err) { return null; }
}

const mqttClient = mqtt.connect('mqtts://89c0f9913b464fe793a20c71d78ec5c6.s1.eu.hivemq.cloud:8883', { username: 'unileve', password: 'Unilevepassword1', rejectUnauthorized: false });
mqttClient.on('connect', () => { mqttClient.subscribe('lavanderia/+/status'); });
mqttClient.on('message', (topic, message) => {
    const partes = topic.split('/');
    if (partes.length === 3 && partes[2] === 'status') STATUS_CACHE[partes[1]] = message.toString();
});

function executarDisparo(idMaquina, parametro) {
    let tempoLimpo = String(parametro).replace(/[^0-9]/g, '');
    if (!tempoLimpo || tempoLimpo === "0") tempoLimpo = "45"; 
    STATUS_CACHE[idMaquina] = "OCUPADA - INICIANDO";

    if (!idMaquina.toLowerCase().includes('sec')) {
        mqttClient.publish(`lavanderia/${idMaquina}/comandos`, 'CMD_45', { qos: 1 });
    } else {
        mqttClient.publish(`lavanderia/${idMaquina}/comandos`, `SECAR:${tempoLimpo}`, { qos: 1 });
        setTimeout(() => {
            let st = STATUS_CACHE[idMaquina] || "DISPONIVEL";
            if (!st.includes("TEMPO:") && !st.includes("SECANDO") && !st.includes("OCUPADA") && !st.includes("LAVANDO")) {
                mqttClient.publish(`lavanderia/${idMaquina}/comandos`, 'CMD_SECAR', { qos: 1 });
            }
        }, 12000);
    }
}

app.get('/painel', (req, res) => {
    const donoLogado = req.cookies.dono;
    if (!donoLogado) return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#2c3e50;margin:0}.card{background:white;padding:2rem;border-radius:10px;text-align:center;width:90%;max-width:320px}input{width:100%;padding:10px;margin-bottom:10px}button{width:100%;padding:10px;background:#27ae60;color:white;border:none;border-radius:5px}</style></head><body><div class="card"><h2>Unileve Admin</h2><form action="/login" method="POST"><input type="text" name="usuario" placeholder="Usuário" required><input type="password" name="senha" placeholder="Senha" required><button type="submit">ENTRAR</button></form></div></body></html>`);

    let maquinasDoDono = Object.keys(CLIENTES).filter(id => CLIENTES[id].dono === donoLogado).sort((a, b) => {
        let isSecA = a.toLowerCase().includes('sec'); let isSecB = b.toLowerCase().includes('sec');
        if (isSecA === isSecB) return a.localeCompare(b); return isSecA ? 1 : -1; 
    });

    let htmlCards = maquinasDoDono.map(id => {
        let statusReal = STATUS_CACHE[id] || "AGUARDANDO...";
        let corBadge = "gray"; let textoBadge = "OFFLINE";
        if (statusReal.includes("DISPONIVEL")) { corBadge = "#27ae60"; textoBadge = "ONLINE"; } 
        else if (statusReal.includes("LAVANDO") || statusReal.includes("ENXAGUE") || statusReal.includes("CENTRIF") || statusReal.includes("SECANDO") || statusReal.includes("TEMPO:") || statusReal.includes("OCUPADA")) { corBadge = "#e67e22"; textoBadge = "OCUPADA"; }

        const isSecadora = id.toLowerCase().includes('sec');
        let dadosAtuais = CACHE_DADOS_MAQUINAS[id] || { preco_lavar: "0", preco_secar: "0", tempo: "45", preco_promo: "", dia_promo: "", hora_inicio: "", hora_fim: "" };
        let precoAtivo = isSecadora ? dadosAtuais.preco_secar : dadosAtuais.preco_lavar;

        let botaoCicloNormal = "";
        if (isSecadora) {
            botaoCicloNormal = `<button onclick="acionar('${id}', 'SECAR:${dadosAtuais.tempo}')" style="width:100%; background:#e67e22; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer;">🔥 FORÇAR SECAR (${dadosAtuais.tempo} MIN)</button>`;
        } else {
            botaoCicloNormal = `<button onclick="acionar('${id}', 'CMD_45')" style="width:100%; background:#2980b9; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer; margin-bottom:8px;">💧 FORÇAR LAVAR 45M</button><button onclick="acionar('${id}', 'CMD_ENXAGUE')" style="width:100%; background:#1abc9c; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer;">🌀 SÓ ENXÁGUE/CENTR.</button>`;
        }

        return `<div class="card" style="background:white; padding:15px; border-radius:8px; margin-bottom:15px; box-shadow:0 2px 4px rgba(0,0,0,0.1)">
            <h3>${id.toUpperCase()}</h3>
            <span id="badge-${id}" style="background:${corBadge};color:white;padding:4px 8px;border-radius:4px;font-size:12px; font-weight:bold;">${textoBadge}</span>
            <div id="status-texto-${id}" style="margin-top:10px; font-family:monospace; font-size:14px; color:#2c3e50; font-weight:bold; background:#e8f4f8; padding:8px; border-radius:4px;">${statusReal}</div>
            <div style="display:flex; gap:10px; margin-top:10px;">
                <div style="flex:1; background:#d4edda; color:#155724; padding:8px; border-radius:4px; font-size:14px; font-weight:bold;">💰 Atual: R$ ${precoAtivo}</div>
                <div style="flex:1; background:#d1ecf1; color:#0c5460; padding:8px; border-radius:4px; font-size:14px; font-weight:bold;">⏱️ Ciclo: ${dadosAtuais.tempo} min</div>
            </div>
            <div style="margin-top:15px;">${botaoCicloNormal}</div>
            <button onclick="acionar('${id}', 'CMD_RESET')" style="width:100%; margin-top:8px; background:#c0392b; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer;">🚨 RESET DE EMERGÊNCIA</button>
        </div>`;
    }).join('');

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif; background:#ecf0f1; padding:20px}</style></head><body>
        <div style="display:flex; justify-content:space-between; align-items:center;"><h2>Olá, ${donoLogado}</h2><a href="/logout" style="color:#c0392b; text-decoration:none; font-weight:bold;">Sair</a></div>
        <hr>${htmlCards}
        <script>
        function acionar(id, cmd){ if(confirm('Enviar '+cmd+' para '+id+'?')) fetch('/api/acionar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,cmd})}).then(r=>r.json()).then(d=>alert(d.success?'Comando Enviado!':'Erro')) }
        setInterval(() => { fetch('/api/status_geral').then(res => res.json()).then(dados => {
            for (let id in dados) {
                let badge = document.getElementById('badge-'+id); let statusBox = document.getElementById('status-texto-'+id);
                if (badge) { let st = dados[id]; statusBox.innerText = st; if (st.includes("DISPONIVEL")) { badge.style.background = "#27ae60"; badge.innerText = "ONLINE"; } else if (st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("TEMPO:") || st.includes("OCUPADA")) { badge.style.background = "#e67e22"; badge.innerText = "OCUPADA"; } else { badge.style.background = "gray"; badge.innerText = "OFFLINE"; } }
            }
        }) }, 2000); 
        </script>
    </body></html>`);
});

app.post('/api/atualizar_planilha', async (req, res) => { res.json({ success: true }); });
app.get('/api/status_geral', (req, res) => { res.json(STATUS_CACHE); });
app.post('/login', async (req, res) => { const nomeDono = await autenticarUsuarioNaPlanilha(req.body.usuario, req.body.senha); if (nomeDono) { res.cookie('dono', nomeDono, { httpOnly: true, maxAge: 86400000 }); res.redirect('/painel'); } else res.send(`Incorreto. <a href="/painel">Voltar</a>`); });
app.get('/logout', (req, res) => { res.clearCookie('dono'); res.redirect('/painel'); });
app.post('/api/acionar', (req, res) => { const { id, cmd } = req.body; if (cmd.includes('SECAR:')) { executarDisparo(id, cmd.split(':')[1]); } else { mqttClient.publish(`lavanderia/${id}/comandos`, cmd, { qos: 1 }); } res.json({ success: true }); });

app.post('/api/verificar_pagamento_fisico', async (req, res) => {
    const { id_maquina } = req.body;
    const config = CLIENTES[id_maquina];
    const intentId = INTENTS_ATIVOS[id_maquina];

    if (!config || !intentId) return res.json({ status: 'NONE' });

    try {
        const response = await axios.get(`https://api.mercadopago.com/point/integration-api/payment-intents/${intentId}`, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
        const estado = response.data.state;
        
        if (estado === 'FINISHED') {
            delete INTENTS_ATIVOS[id_maquina]; 
            let tempo = '45'; 
            if (response.data.additional_info && response.data.additional_info.external_reference) {
                const partes = response.data.additional_info.external_reference.split('|');
                if (partes[1]) tempo = partes[1];
            }
            executarDisparo(id_maquina, tempo);
            return res.json({ status: 'APPROVED' });
        } else if (estado === 'CANCELED' || estado === 'ERROR' || estado === 'ABANDONED') {
            delete INTENTS_ATIVOS[id_maquina];
            return res.json({ status: 'REJECTED' });
        }
        res.json({ status: 'PENDING' });
    } catch (e) {
        res.json({ status: 'ERROR' });
    }
});

app.post('/api/pagar_fisico', async (req, res) => {
    let { id_maquina, tempo } = req.body; 
    const config = CLIENTES[id_maquina];
    if (!config || !config.device_id) return res.status(400).json({ error: "Máquina não configurada." });

    if (INTENTS_ATIVOS[id_maquina]) {
        forcarCancelamentoMP(config.device_id, INTENTS_ATIVOS[id_maquina], config.token_mp);
        delete INTENTS_ATIVOS[id_maquina];
    }

    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero na planilha." });

        await aplicarMarretaExtrema(config.device_id, config.token_mp);

        const ordemPagamento = { amount: Math.round(parseFloat(dados.preco) * 100), description: `Unileve - ${id_maquina}`, additional_info: { external_reference: `${id_maquina}|${dados.tempo}`, print_on_terminal: false } };
        const response = await axios.post(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, ordemPagamento, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
        INTENTS_ATIVOS[id_maquina] = response.data.id; res.json({ success: true, intent_id: response.data.id });
    } catch (error) { 
        res.status(500).json({ error: "A maquininha não respondeu.<br><br>Se ela estiver travada ou na tela inicial, toque na <b>SETA DE VOLTAR ( &larr; )</b> nela e tente novamente." }); 
    }
});

app.post('/api/cancelar_fisico', async (req, res) => {
    const { id_maquina } = req.body; 
    const config = CLIENTES[id_maquina]; 
    if (!config) return res.json({ success: false });
    
    if (INTENTS_ATIVOS[id_maquina]) {
        await forcarCancelamentoMP(config.device_id, INTENTS_ATIVOS[id_maquina], config.token_mp);
        delete INTENTS_ATIVOS[id_maquina]; 
    }
    
    await aplicarMarretaExtrema(config.device_id, config.token_mp);
    res.json({ success: true });
});

app.post('/criar_pagamento', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    if (tempo === '45' || tempo === 'CMD_45') tempo = 'preco_45'; if (String(tempo).toLowerCase().includes('sec')) tempo = 'preco_secar';
    const config = CLIENTES[id_maquina]; if (!config) return res.status(400).json({ error: "Máquina não configurada" });
    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero" });
        const preference = { items: [{ title: `Ciclo ${dados.tempo}min - ${id_maquina}`, unit_price: parseFloat(dados.preco), quantity: 1, currency_id: 'BRL' }], metadata: { maquina: id_maquina, tempo_planilha: dados.tempo }, payer: { email: `cliente_@lavanderia.com` }, payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }], installments: 1 }, notification_url: "https://lavanderia-v2.onrender.com/webhook", auto_return: "approved", back_urls: { success: "https://lavanderia-v2.onrender.com/sucesso", failure: "https://lavanderia-v2.onrender.com/erro" } };
        const response = await axios.post('https://api.mercadopago.com/checkout/preferences', preference, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
        res.json({ status: 'ok', init_point: response.data.init_point });
    } catch (e) { res.status(500).json({ error: "Erro MP" }); }
});

app.post('/api/gerar_pix', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    if (tempo === '45' || tempo === 'CMD_45') tempo = 'preco_45'; if (String(tempo).toLowerCase().includes('sec')) tempo = 'preco_secar';
    const config = CLIENTES[id_maquina]; if (!config) return res.status(400).json({ error: "Configuração não encontrada" });

    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero na planilha." });
        const paymentData = { transaction_amount: parseFloat(dados.preco), description: `Unileve - ${id_maquina}`, payment_method_id: "pix", payer: { email: `c_${Date.now()}@mail.com` }, metadata: { maquina: id_maquina, tempo_planilha: dados.tempo }, notification_url: "https://lavanderia-v2.onrender.com/webhook" };
        const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, { headers: { 'Authorization': `Bearer ${config.token_mp}`, 'X-Idempotency-Key': `${id_maquina}-${Date.now()}` } });
        res.json({ success: true, qr_code_base64: response.data.point_of_interaction.transaction_data.qr_code_base64, qr_code: response.data.point_of_interaction.transaction_data.qr_code });
    } catch (e) { res.status(500).json({ error: "Erro Pix" }); }
});

app.post('/webhook', async (req, res) => {
    let tipoEvento = req.query.type || req.body.type || req.body.action || req.query.topic;
    if (tipoEvento === 'point_integration_wh') {
        const info = req.body;
        if (info.state === 'FINISHED' && info.payment && info.payment.state === 'approved' && info.additional_info && info.additional_info.external_reference) {
            const partes = info.additional_info.external_reference.split('|');
            if (partes[0] && partes[1]) executarDisparo(partes[0], partes[1]); 
        }
        return res.sendStatus(200);
    }
    if (tipoEvento === 'payment' || tipoEvento === 'payment.created') {
        const idPagamento = (req.body.data && req.body.data.id) ? req.body.data.id : req.query['data.id'];
        if (idPagamento) {
            const tokensUnicos = [...new Set(Object.values(CLIENTES).map(c => c.token_mp))];
            for (const token of tokensUnicos) {
                try {
                    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${idPagamento}`, { headers: { 'Authorization': `Bearer ${token}` } });
                    if (response.data.status === 'approved') {
                        let maquina = null; let tempo = "45";
                        if (response.data.metadata && response.data.metadata.maquina) { maquina = response.data.metadata.maquina; tempo = response.data.metadata.tempo_planilha || "45"; } 
                        else if (response.data.external_reference && response.data.external_reference.includes('|')) { const partes = response.data.external_reference.split('|'); maquina = partes[0]; tempo = partes[1]; }
                        if (maquina) { executarDisparo(maquina, tempo); return res.sendStatus(200); }
                    }
                } catch (err) {}
            }
        }
    }
    res.sendStatus(200);
});

app.get('/sucesso', (req, res) => res.send(`<h2>✅ Sucesso!</h2>`));
app.get('/erro', (req, res) => res.send(`<h2>❌ Erro!</h2>`));

// --- TOTEM VIEW ---
app.get('/totem/:donoUrl', (req, res) => {
    const donoRequisitado = req.params.donoUrl.toLowerCase();
    let maquinasDaLoja = Object.keys(CLIENTES).filter(id => CLIENTES[id].dono.toLowerCase() === donoRequisitado);
    if (maquinasDaLoja.length === 0) return res.send("<h1 style='text-align:center; margin-top:50px;'>Nenhuma máquina encontrada.</h1>");

    let conjuntos = {};
    maquinasDaLoja.forEach(id => {
        let numero = (id.match(/\d+$/) || [id.toUpperCase()])[0];
        if (!conjuntos[numero]) conjuntos[numero] = { lavadora: null, secadora: null };
        if (id.toLowerCase().includes('sec')) conjuntos[numero].secadora = id;
        else conjuntos[numero].lavadora = id;
    });

    let htmlConjuntos = '';
    Object.keys(conjuntos).sort().forEach(num => {
        let conj = conjuntos[num];
        let btnSecadora = ''; let btnLavadora = '';
        if (conj.secadora) {
            let isOcupada = (STATUS_CACHE[conj.secadora] || "").includes("TEMPO:") || (STATUS_CACHE[conj.secadora] || "").includes("SECANDO") || (STATUS_CACHE[conj.secadora] || "").includes("OCUPADA");
            btnSecadora = `<button class="btn-maq secadora ${isOcupada ? 'ocupada' : ''}" onclick="${isOcupada ? '' : `iniciarFluxo('${conj.secadora}', '${num}', 'secar')`}"><div class="icon">🔥</div><h3>SECADORA ${num}</h3><p>${isOcupada ? 'EM USO' : 'TOCAR PARA PAGAR'}</p></button>`;
        }
        if (conj.lavadora) {
            let isOcupada = (STATUS_CACHE[conj.lavadora] || "").includes("TEMPO:") || (STATUS_CACHE[conj.lavadora] || "").includes("LAVANDO") || (STATUS_CACHE[conj.lavadora] || "").includes("OCUPADA");
            btnLavadora = `<button class="btn-maq lavadora ${isOcupada ? 'ocupada' : ''}" onclick="${isOcupada ? '' : `iniciarFluxo('${conj.lavadora}', '${num}', 'lavar')`}"><div class="icon">💧</div><h3>LAVADORA ${num}</h3><p>${isOcupada ? 'EM USO' : 'TOCAR PARA PAGAR'}</p></button>`;
        }
        htmlConjuntos += `<div class="conjunto-card"><div class="conjunto-title">CONJUNTO ${num}</div>${btnSecadora}${btnLavadora}</div>`;
    });

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #eef2f5; margin: 0; padding: 0; user-select: none; }
        .tela { display: none; min-height: 100vh; flex-direction: column; align-items: center; justify-content: center; width: 100%; box-sizing: border-box; padding: 20px; }
        .tela.ativa { display: flex; }
        #tela-principal { align-items: center; justify-content: flex-start; padding-top: 40px; }
        .header-title { color: #34495e; text-align: center; margin-bottom: 30px; }
        .header-title h1 { margin: 0; font-size: 32px; }
        .header-title p { margin: 5px 0 0 0; color: #7f8c8d; font-size: 18px; }
        .grid-conjuntos { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; max-width: 1200px; }
        .conjunto-card { background: #fff; border-radius: 15px; padding: 20px; width: 260px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); display:flex; flex-direction:column; gap:15px; }
        .conjunto-title { text-align: center; color: #7f8c8d; font-weight: bold; letter-spacing: 1px; font-size: 14px; }
        .btn-maq { border: none; border-radius: 12px; padding: 20px 10px; color: white; cursor: pointer; transition: transform 0.1s; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
        .btn-maq:active { transform: scale(0.97); }
        .btn-maq h3 { margin: 10px 0 5px 0; font-size: 18px; }
        .btn-maq p { margin: 0; font-size: 12px; font-weight: bold; background: rgba(0,0,0,0.2); padding: 5px 10px; border-radius: 20px; }
        .btn-maq .icon { font-size: 35px; }
        .secadora { background: linear-gradient(135deg, #e67e22, #d35400); }
        .lavadora { background: linear-gradient(135deg, #3498db, #2980b9); }
        .ocupada { filter: grayscale(100%); opacity: 0.6; cursor: not-allowed; }
        .tela-escura { background: #2c3e50; color: white; text-align: center; }
        .icon-gigante { font-size: 60px; margin-bottom: 10px; }
        .box-aviso { max-width: 500px; width: 100%; }
        .box-aviso h2 { color: #f1c40f; font-size: 30px; margin-bottom: 20px; }
        .box-aviso p { font-size: 20px; line-height: 1.5; margin-bottom: 30px; }
        .alerta-vermelho { background: rgba(231, 76, 60, 0.2); border: 1px solid #e74c3c; color: #e74c3c; padding: 10px; border-radius: 8px; font-size: 14px; font-weight: bold; margin-bottom: 30px; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        .btn-acao { padding: 20px; font-size: 18px; font-weight: bold; color: white; border: none; border-radius: 10px; cursor: pointer; }
        .btn-vermelho { background: #e74c3c; }
        .btn-verde { background: #27ae60; }
        .btn-pagamento { width: 100%; margin-bottom: 15px; padding: 25px; border-radius: 12px; border: none; color: white; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
        .btn-pagamento.cartao { background: linear-gradient(135deg, #e74c3c, #c0392b); }
        .btn-pagamento.pix { background: linear-gradient(135deg, #2ecc71, #27ae60); }
        .btn-pagamento h3 { margin: 0 0 5px 0; font-size: 24px; }
        .btn-pagamento p { margin: 0; font-size: 14px; opacity: 0.9; }
        .btn-cancelar { background: transparent; border: 2px solid #7f8c8d; color: #bdc3c7; width: 100%; padding: 15px; border-radius: 10px; font-size: 16px; font-weight: bold; margin-top: 20px; cursor: pointer; }
        .box-branca { background: white; padding: 20px; border-radius: 15px; display: inline-block; margin: 20px 0; }
        #modal-alerta { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 9999; justify-content: center; align-items: center; }
        .alerta-box { background: white; padding: 30px; border-radius: 15px; text-align: center; max-width: 400px; color: #2c3e50; }
        .alerta-box h3 { color: #e74c3c; margin-top: 0; font-size: 24px; }
        .alerta-btn { background: #34495e; color: white; border: none; padding: 15px 30px; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 20px; width: 100%; }
        .spinner { border: 4px solid rgba(255,255,255,0.3); border-radius: 50%; border-top: 4px solid #2ecc71; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style></head><body>
        <div id="tela-principal" class="tela ativa"><div class="header-title"><h1>Bem-vindo à Unileve</h1><p>Toque na máquina que você deseja usar:</p></div><div class="grid-conjuntos">${htmlConjuntos}</div></div>
        <div id="tela-atencao" class="tela tela-escura"><div class="box-aviso"><div class="icon-gigante">👕</div><h2>ATENÇÃO</h2><p id="txt-pergunta-roupa">Você já colocou as roupas na MÁQUINA e fechou a porta?</p><div class="alerta-vermelho">⚠️ Após o pagamento aprovado, a máquina iniciará automaticamente.</div><div class="grid-2"><button class="btn-acao btn-vermelho" onclick="voltarInicio()">NÃO, VOU COLOCAR</button><button class="btn-acao btn-verde" onclick="mostrarPagamento()">SIM, JÁ COLOQUEI!</button></div></div></div>
        <div id="tela-pagamento" class="tela tela-escura"><div class="box-aviso"><h2 style="color:white; margin-bottom:40px;">Como deseja pagar?</h2><button class="btn-pagamento cartao" onclick="pagarCartao()"><h3>💳 CARTÃO</h3><p>Na maquininha ao lado</p></button><button class="btn-pagamento pix" onclick="pagarPix()"><h3>🟢 PIX</h3><p>Ler QR Code nesta tela</p></button><button class="btn-cancelar" onclick="voltarInicio()">CANCELAR</button></div></div>
        <div id="tela-cartao" class="tela tela-escura"><div class="box-aviso"><div class="icon-gigante" style="color:#e74c3c;">💳</div><h2 style="color:white;">Vá até a maquininha ao lado!</h2><p id="txt-liberar-cartao">Aproxime ou insira seu cartão para liberar a MÁQUINA.</p><button class="btn-cancelar" onclick="cancelarTransacao()">CANCELAR COMPRA</button></div></div>
        <div id="tela-pix" class="tela tela-escura"><div class="box-aviso"><h2 style="color:#2ecc71;">Pague com PIX</h2><p>Abra o app do seu banco e escaneie o código abaixo:</p><div id="loading-pix"><div class="spinner"></div><p>Gerando código PIX...</p></div><div id="area-qrcode" style="display:none;"><div class="box-branca"><img id="imgPix" src="" style="width:250px; height:250px; display:block;" /></div><p style="color:#f1c40f; font-size:16px;">A máquina iniciará automaticamente após o pagamento.</p></div><button class="btn-cancelar" onclick="voltarInicio()">CANCELAR COMPRA</button></div></div>
        <div id="tela-sucesso" class="tela tela-escura"><div class="box-aviso"><div class="icon-gigante" style="color:#27ae60;">✅</div><h2 style="color:#27ae60; font-size:40px;">Pagamento Aprovado!</h2><p>A sua máquina foi iniciada com sucesso.</p></div></div>
        
        <div id="modal-alerta"><div class="alerta-box"><div class="icon-gigante">⏳</div><h3 id="alerta-titulo">Aviso</h3><p id="alerta-msg">Mensagem</p><button class="alerta-btn" onclick="fecharAlerta()">ENTENDIDO</button></div></div>

        <script>
            let maqAlvo = ''; let nomeExibicao = ''; let tipoAlvo = ''; let tempoAlvo = '';
            let intervaloFisico = null; let intervaloPix = null; let timerInatividade = null; 

            function mostrarTela(id) { document.querySelectorAll('.tela').forEach(t => t.classList.remove('ativa')); document.getElementById(id).classList.add('ativa'); }
            function voltarInicio() { if(intervaloFisico) clearInterval(intervaloFisico); if(intervaloPix) clearInterval(intervaloPix); if(timerInatividade) clearTimeout(timerInatividade); mostrarTela('tela-principal'); }
            function exibirAlerta(titulo, msg) { 
                document.getElementById('alerta-titulo').innerText = titulo; 
                document.getElementById('alerta-msg').innerHTML = msg; 
                document.getElementById('modal-alerta').style.display = 'flex'; 
            }
            function fecharAlerta() { document.getElementById('modal-alerta').style.display = 'none'; voltarInicio(); }
            
            function iniciarCronometro() { 
                if(timerInatividade) clearTimeout(timerInatividade); 
                timerInatividade = setTimeout(() => { 
                    if(intervaloFisico) clearInterval(intervaloFisico); 
                    if(intervaloPix) clearInterval(intervaloPix);
                    fetch('/api/cancelar_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: maqAlvo }) });
                    exibirAlerta("Tempo Esgotado", "Cancelamos a operação por inatividade.<br><br>Se a maquininha física continuar acesa, por favor, toque na <b>SETA DE VOLTAR ( &larr; )</b> no canto superior esquerdo da tela dela para retornar ao menu principal."); 
                }, 75000); 
            }
            
            function iniciarFluxo(id, numero, tipo) { maqAlvo = id; tipoAlvo = tipo; nomeExibicao = (tipo === 'secar' ? 'SECADORA ' : 'LAVADORA ') + numero; tempoAlvo = (tipo === 'secar') ? 'preco_secar' : 'preco_45'; document.getElementById('txt-pergunta-roupa').innerText = 'Você já colocou as roupas na ' + nomeExibicao + ' e fechou a porta?'; document.getElementById('txt-liberar-cartao').innerText = 'Aproxime ou insira seu cartão para liberar a ' + nomeExibicao + '.'; mostrarTela('tela-atencao'); }
            function mostrarPagamento() { mostrarTela('tela-pagamento'); }

            function pagarCartao() {
                mostrarTela('tela-cartao');
                fetch('/api/pagar_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: maqAlvo, tempo: tempoAlvo }) })
                .then(r => r.json()).then(d => { if(d.error) { exibirAlerta("Aviso", d.error); } else { iniciarRadarMaquininha(maqAlvo); iniciarCronometro(); } }).catch(e => voltarInicio());
            }

            function pagarPix() {
                mostrarTela('tela-pix'); 
                document.getElementById('loading-pix').style.display = 'block'; 
                document.getElementById('area-qrcode').style.display = 'none';
                
                fetch('/api/gerar_pix', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id_maquina: maqAlvo, tempo: tempoAlvo}) })
                .then(r => r.json()).then(d => { 
                    if (d.success) { 
                        document.getElementById('loading-pix').style.display = 'none'; 
                        document.getElementById('area-qrcode').style.display = 'block'; 
                        document.getElementById('imgPix').src = "data:image/jpeg;base64," + d.qr_code_base64; 
                        iniciarRadarPix(maqAlvo); 
                        iniciarCronometro(); 
                    } else { 
                        exibirAlerta("Aviso", "Não foi possível gerar o código PIX no momento. Tente novamente ou use cartão."); 
                    } 
                }).catch(e => voltarInicio());
            }

            function cancelarTransacao() { fetch('/api/cancelar_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: maqAlvo }) }); voltarInicio(); }

            function iniciarRadarMaquininha(id) { 
                intervaloFisico = setInterval(async () => { 
                    try { 
                        let resMp = await fetch('/api/verificar_pagamento_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: id }) });
                        let dataMp = await resMp.json();
                        if (dataMp.status === 'APPROVED') { clearInterval(intervaloFisico); if(timerInatividade) clearTimeout(timerInatividade); mostrarTela('tela-sucesso'); setTimeout(() => window.location.reload(), 4000); return; } 
                        else if (dataMp.status === 'REJECTED') { clearInterval(intervaloFisico); exibirAlerta("Operação Cancelada", "O pagamento foi cancelado na maquininha."); return; }
                        let res = await fetch('/api/status_geral?t=' + new Date().getTime()); let statusCache = await res.json(); let st = statusCache[id] || "DISPONIVEL"; 
                        if (st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("TEMPO:") || st.includes("OCUPADA")) { clearInterval(intervaloFisico); if(timerInatividade) clearTimeout(timerInatividade); mostrarTela('tela-sucesso'); setTimeout(() => window.location.reload(), 4000); } 
                    } catch(e) { } 
                }, 2500); 
            }

            function iniciarRadarPix(id) { 
                intervaloPix = setInterval(async () => { 
                    try { 
                        let res = await fetch('/api/status_geral?t=' + new Date().getTime()); let statusCache = await res.json(); let st = statusCache[id] || "DISPONIVEL"; 
                        if (st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("TEMPO:") || st.includes("OCUPADA")) { clearInterval(intervaloPix); if(timerInatividade) clearTimeout(timerInatividade); mostrarTela('tela-sucesso'); setTimeout(() => window.location.reload(), 4000); } 
                    } catch(e) {} 
                }, 2500); 
            }
        </script>
    </body></html>`);
});

// ==========================================
// ⏰ O DESPERTADOR COM MARRETA INVERTIDA
// ==========================================
setInterval(async () => {
    console.log("[DESPERTADOR] Iniciando rotina de limpeza matinal...");
    for (let id_maquina in CLIENTES) {
        let config = CLIENTES[id_maquina];
        if (config && config.device_id && !INTENTS_ATIVOS[id_maquina]) {
            try {
                console.log(`[DESPERTADOR] Forçando modo PDV na máquina ${id_maquina}...`);
                await aplicarMarretaExtrema(config.device_id, config.token_mp);
                
                const ordemFantasma = { amount: 100, description: `Despertador`, additional_info: { external_reference: `ping`, print_on_terminal: false } };
                const resp = await axios.post(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, ordemFantasma, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
                
                await new Promise(resolve => setTimeout(resolve, 3000));
                try { await axios.delete(`https://api.mercadopago.com/point/integration-api/payment-intents/${resp.data.id}`, { headers: { 'Authorization': `Bearer ${config.token_mp}` } }); } catch(e) {}
                
            } catch (e) {
                console.log(`[DESPERTADOR] Falha ao acordar ${id_maquina}. A máquina deve estar OFF ou Ocupada.`);
            }
        }
    }
}, 3 * 60 * 60 * 1000); // ⚠️ Mantido em 5 minutos para teste. Quando o teste passar, mude para: 3 * 60 * 60 * 1000 (para 3h), 5 * 60 * 1000 ( pra 5 minutos)
// ==========================================
// 🔄 ROTINA DE AUTO-PING (Anti-Standby do Render)
// ==========================================
// Rota leve apenas para responder ao ping
app.get('/api/autoping', (req, res) => res.send('pong'));

setInterval(async () => {
    try {
        // Alvo baseado na URL principal do seu servidor que vimos nos logs
        await axios.get('https://lavanderia-server.onrender.com/api/autoping');
        console.log('[AUTO-PING] Servidor chamado com sucesso para evitar a pausa de 15 minutos.');
    } catch (e) {
        console.log('[AUTO-PING] Erro ao tentar chamar a si mesmo:', e.message);
    }
}, 10 * 60 * 1000); // ⏱️ Executa rigidamente a cada 10 minutos
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor Pronto na porta ${PORT}`));
