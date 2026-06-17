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

async function forcarCancelamentoMP(deviceId, intentId, token) {
    try {
        await axios.delete(`https://api.mercadopago.com/point/integration-api/payment-intents/${intentId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        return true;
    } catch (e1) {
        try {
            await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${deviceId}/payment-intents/${intentId}`, { headers: { 'Authorization': `Bearer ${token}` } });
            return true;
        } catch (e2) {
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
        if (linhas && linhas.length > 1) {
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
        
        let txtPromo = "Nenhuma promoção programada.";
        if (dadosAtuais.preco_promo && dadosAtuais.dia_promo) { txtPromo = `<span style="font-size:16px;">R$ ${dadosAtuais.preco_promo}</span><br>${dadosAtuais.dia_promo} | ${dadosAtuais.hora_inicio || "00:00"} às ${dadosAtuais.hora_fim || "23:59"}`; }

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

        const ordemPagamento = { amount: Math.round(parseFloat(dados.preco) * 100), description: `Unileve - ${id_maquina}`, additional_info: { external_reference: `${id_maquina}|${dados.tempo}`, print_on_terminal: false } };
        const response = await axios.post(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, ordemPagamento, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
        INTENTS_ATIVOS[id_maquina] = response.data.id; 
        res.json({ success: true, intent_id: response.data.id });
    } catch (error) { 
        res.status(500).json({ error: "A maquininha não respondeu.<br><br>Se ela estiver na tela inicial, <b>TOQUE NO BOTÃO 'INSERIR VALOR'</b> nela para ativar o pagamento." }); 
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
        htmlConjuntos += `<div class="conjunto-card"><div class="conjunto-title">CON
