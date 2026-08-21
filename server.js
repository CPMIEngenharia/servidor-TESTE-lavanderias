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

// --- O GUARDA DE TRÂNSITO ---
app.get('/', (req, res, next) => {
    if (req.query.id) return res.redirect('/app/' + req.query.id);
    next();
});
app.use(express.static('public'));

// --- 1. CONFIGURAÇÕES ---
const MASTER_SHEET_ID = "19427ddGD6PLr38I_hELCd6OhA89UycUyTNt-h7Exb8I";
let CLIENTES = {};
let STATUS_CACHE = {};
let INTENTS_ATIVOS = {};
let CACHE_DADOS_MAQUINAS = {};

// --- 2. AUTENTICAÇÃO GOOGLE (ESCRITA) ---
function getGoogleAuth() {
    return new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

// --- 3. CARREGAR CONFIGURAÇÕES MESTRE ---
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
                    CLIENTES[id.trim()] = {
                        dono: dono.trim(),
                        token_mp: token ? token.trim() : "",
                        sheet_id: sheet ? sheet.trim() : "",
                        usa_maquininha: maquininha && String(maquininha).trim().toUpperCase() === "SIM",
                        device_id: deviceId ? deviceId.trim() : ""
                    };
                }
            }
        }
    } catch (err) { console.error("❌ Erro Planilha Mestre:", err.message); }
}

// --- 4. CACHE DE PREÇOS E PROMOÇÕES ---
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
                if (!idMaq) continue;
                idMaq = idMaq.trim();
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

// --- 5. MQTT ---
const mqttClient = mqtt.connect('mqtts://89c0f9913b464fe793a20c71d78ec5c6.s1.eu.hivemq.cloud:8883', { username: 'unileve', password: 'Unilevepassword1', rejectUnauthorized: false });
mqttClient.on('connect', () => { mqttClient.subscribe('lavanderia/+/status'); });
mqttClient.on('message', (topic, message) => {
    const partes = topic.split('/');
    if (partes.length === 3 && partes[2] === 'status') STATUS_CACHE[partes[1]] = message.toString();
});

// --- 6. O CÉREBRO DE DESPACHO ---
function executarDisparo(idMaquina, parametro) {
    let idLimpo = String(idMaquina).trim();
    let tempoLimpo = String(parametro).replace(/[^0-9]/g, '');
    if (!tempoLimpo || tempoLimpo === "0") tempoLimpo = "45";

    if (!idLimpo.toLowerCase().includes('sec')) {
        mqttClient.publish(`lavanderia/${idLimpo}/comandos`, 'CMD_45', { qos: 1 });
    } else {
        mqttClient.publish(`lavanderia/${idLimpo}/comandos`, `SECAR:${tempoLimpo}`, { qos: 1 });
        
        setTimeout(() => {
            let st = STATUS_CACHE[idLimpo] || "DISPONIVEL";
            if (!st.includes("TEMPO:") && !st.includes("SECANDO") && !st.includes("OCUPADA") && !st.includes("LAVANDO")) {
                console.log(`⚠️ [PLACA ANTIGA EM ${idLimpo}] Disparando Fallbacks de 60min`);
                mqttClient.publish(`lavanderia/${idLimpo}/comandos`, 'CMD_SECAR', { qos: 1 });
                mqttClient.publish(`lavanderia/${idLimpo}/comandos`, 'CMD_45', { qos: 1 });
            } else {
                console.log(`✅ [${idLimpo}] Comando inteligente aceite com sucesso!`);
            }
        }, 12000);
    }
}

// --- 7. PAINEL DO DONO ---
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
        else if (statusReal.includes("LAVANDO") || statusReal.includes("ENXAGUE") || statusReal.includes("CENTRIF") || statusReal.includes("SECANDO") || statusReal.includes("TEMPO:")) { corBadge = "#e67e22"; textoBadge = "OCUPADA"; }
        const isSecadora = id.toLowerCase().includes('sec');
        let dadosAtuais = CACHE_DADOS_MAQUINAS[id] || { preco_lavar: "0", preco_secar: "0", tempo: "45", preco_promo: "", dia_promo: "", hora_inicio: "", hora_fim: "" };
        let precoAtivo = isSecadora ? dadosAtuais.preco_secar : dadosAtuais.preco_lavar;
        let txtPromo = "Nenhuma promoção programada.";
        if (dadosAtuais.preco_promo && dadosAtuais.dia_promo) {
            txtPromo = `<span style="font-size:16px;">R$ ${dadosAtuais.preco_promo}</span><br>${dadosAtuais.dia_promo} | ${dadosAtuais.hora_inicio || "00:00"} às ${dadosAtuais.hora_fim || "23:59"}`;
        }
        let botaoCicloNormal = isSecadora
            ? `<button onclick="acionar('${id}', 'SECAR:${dadosAtuais.tempo}')" style="width:100%; background:#e67e22; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer;">🔥 FORÇAR SECAR (${dadosAtuais.tempo} MIN)</button>`
            : `<button onclick="acionar('${id}', 'CMD_45')" style="width:100%; background:#2980b9; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer; margin-bottom:8px;">💧 FORÇAR LAVAR 45M</button><button onclick="acionar('${id}', 'CMD_ENXAGUE')" style="width:100%; background:#1abc9c; color:white; border:none; padding:15px; border-radius:4px; font-weight:bold; font-size:16px; cursor:pointer;">🌀 SÓ ENXÁGUE/CENTR.</button>`;
        return `<div class="card" style="background:white; padding:15px; border-radius:8px; margin-bottom:15px; box-shadow:0 2px 4px rgba(0,0,0,0.1)">
            <h3 style="margin-top:0;">${id.toUpperCase()}</h3>
            <span id="badge-${id}" style="background:${corBadge};color:white;padding:4px 8px;border-radius:4px;font-size:12px; font-weight:bold;">${textoBadge}</span>
            <div id="status-texto-${id}" style="margin-top:10px; font-family:monospace; font-size:14px; color:#2c3e50; font-weight:bold; background:#e8f4f8; padding:8px; border-radius:4px;">${statusReal}</div>
            <div style="display:flex; gap:10px; margin-top:10px;">
                <div style="flex:1; background:#d4edda; color:#155724; padding:8px; border-radius:4px; font-size:14px; font-weight:bold;">💰 Atual: R$ ${precoAtivo}</div>
                <div style="flex:1; background:#d1ecf1; color:#0c5460; padding:8px; border-radius:4px; font-size:14px; font-weight:bold;">⏱️ Ciclo: ${dadosAtuais.tempo} min</div>
            </div>
            <div style="margin-top:8px; background:#fff3cd; color:#856404; padding:8px; border-radius:4px; font-size:13px; border: 1px solid #ffeeba; text-align:center;">
                <b>🎉 Promoção Programada:</b><br><span style="font-weight:normal;">${txtPromo}</span>
            </div>
            <div style="margin-top:15px; padding:10px; background:#f8f9fa; border-radius:8px; border:1px solid #ddd; text-align:left;">
                <p style="font-size:12px; margin:0 0 5px 0; color:#333; font-weight:bold;">📝 Mudar Configuração Padrão:</p>
                <div style="display:flex; gap:5px; margin-bottom:10px;">
                    <input type="text" id="preco-${id}" placeholder="Preço Padrão" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                    <input type="number" id="tempo-${id}" placeholder="Tempo (Min)" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                </div>
                <p style="font-size:12px; margin:0 0 5px 0; color:#e67e22; font-weight:bold;">🎉 Configurar Novo Happy Hour:</p>
                <div style="display:flex; gap:5px; margin-bottom:5px;">
                    <input type="text" id="preco_promo-${id}" placeholder="Preço Promo" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                    <input type="text" id="dia_promo-${id}" placeholder="Dias" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                </div>
                <div style="display:flex; gap:5px;">
                    <div style="flex:1; display:flex; flex-direction:column;"><label style="font-size:10px; color:#7f8c8d; font-weight:bold; margin-bottom:2px;">Hora Início:</label><input type="time" id="hora_inicio-${id}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;"></div>
                    <div style="flex:1; display:flex; flex-direction:column;"><label style="font-size:10px; color:#7f8c8d; font-weight:bold; margin-bottom:2px;">Hora Fim:</label><input type="time" id="hora_fim-${id}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;"></div>
                </div>
                <button onclick="salvarPlanilha('${id}')" style="width:100%; margin-top:12px; background:#2c3e50; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer;">💾 SALVAR PLANILHA</button>
                <button onclick="encerrarPromo('${id}')" style="width:100%; margin-top:5px; background:#e74c3c; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer;">❌ ENCERRAR PROMOÇÃO</button>
            </div>
            <div style="margin-top:15px;">${botaoCicloNormal}</div>
            <div style="margin-top:8px; display:grid; grid-template-columns:1fr 1fr; gap:5px;">
                <button onclick="acionar('${id}', 'CMD_FORCA_LIGA')" style="background:#8e44ad; color:white; border:none; padding:8px; border-radius:4px; font-size:12px; cursor:pointer;">⚙️ FORÇAR LIGA</button>
                <button onclick="acionar('${id}', 'CMD_FORCA_START')" style="background:#f1c40f; color:#333; border:none; padding:8px; border-radius:4px; font-size:12px; font-weight:bold; cursor:pointer;">⚙️ FORÇAR START</button>
            </div>
            <button onclick="acionar('${id}', 'CMD_RESET')" style="width:100%; margin-top:8px; background:#c0392b; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer;">🚨 RESET DE EMERGÊNCIA</button>
        </div>`;
    }).join('');
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif; background:#ecf0f1; padding:20px}</style></head><body>
        <div style="display:flex; justify-content:space-between; align-items:center;"><h2>Olá, ${donoLogado}</h2><a href="/logout" style="color:#c0392b; text-decoration:none; font-weight:bold;">Sair</a></div>
        <hr>${htmlCards}
        <script>
        function acionar(id, cmd){ if(confirm('Enviar '+cmd+' para '+id+'?')) fetch('/api/acionar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,cmd})}).then(r=>r.json()).then(d=>alert(d.success?'Comando Enviado!':'Erro')) }
        function salvarPlanilha(id) {
            const preco = document.getElementById('preco-'+id).value, tempo = document.getElementById('tempo-'+id).value, preco_promo = document.getElementById('preco_promo-'+id).value, dia_promo = document.getElementById('dia_promo-'+id).value, hora_inicio = document.getElementById('hora_inicio-'+id).value, hora_fim = document.getElementById('hora_fim-'+id).value;
            if(!preco && !tempo && !preco_promo && !dia_promo && !hora_inicio && !hora_fim) return alert('Preencha algo!');
            fetch('/api/atualizar_planilha', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id_maquina: id, preco, tempo, preco_promo, dia_promo, hora_inicio, hora_fim }) })
            .then(r => r.json()).then(d => { if(d.success) { alert('✅ Salvo!'); window.location.reload(); } else alert('❌ Erro'); });
        }
        function encerrarPromo(id) {
            if(confirm('Encerrar promoção e voltar ao preço normal?')) fetch('/api/atualizar_planilha', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id_maquina: id, limpar_promo: true }) }).then(r => r.json()).then(d => { if(d.success) { alert('🗑️ Promoção Encerrada!'); window.location.reload(); } });
        }
        setInterval(() => { fetch('/api/status_geral').then(res => res.json()).then(dados => {
            for (let id in dados) {
                let badge = document.getElementById('badge-'+id); let statusBox = document.getElementById('status-texto-'+id);
                if (badge) { let st = dados[id]; statusBox.innerText = st; if (st.includes("DISPONIVEL")) { badge.style.background = "#27ae60"; badge.innerText = "ONLINE"; } else if (st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("TEMPO:")) { badge.style.background = "#e67e22"; badge.innerText = "OCUPADA"; } else { badge.style.background = "gray"; badge.innerText = "OFFLINE"; } }
            }
        }) }, 2000);
        </script>
    </body></html>`);
});

// --- 8. ATUALIZAR PLANILHA ---
function getColLetter(colIndex) {
    let letter = ''; while (colIndex >= 0) { letter = String.fromCharCode((colIndex % 26) + 65) + letter; colIndex = Math.floor(colIndex / 26) - 1; } return letter;
}
app.post('/api/atualizar_planilha', async (req, res) => {
    const dono = req.cookies.dono; const { id_maquina, preco, tempo, preco_promo, dia_promo, hora_inicio, hora_fim, limpar_promo } = req.body;
    if (!dono || !CLIENTES[id_maquina] || CLIENTES[id_maquina].dono !== dono) return res.status(403).json({ error: "Proibido" });
    try {
        const sheetId = CLIENTES[id_maquina].sheet_id; const auth = getGoogleAuth(); const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'A:Z' });
        const linhas = response.data.values; const cabecalho = linhas[0];
        const linhaIndex = linhas.findIndex(l => l[0] && l[0].trim() === id_maquina.trim());
        if (linhaIndex === -1) return res.status(404).json({ error: "Máquina não achada" });
        const rowNumber = linhaIndex + 1;
        const colPrecoIndex = cabecalho.findIndex(c => c && c.trim() === 'Preço Padrão');
        const colTempoIndex = cabecalho.findIndex(c => c && (c.trim() === 'Tempo do Ciclo' || c.trim() === 'Tempo Padrão'));
        const colPrecoPromoIndex = cabecalho.findIndex(c => c && c.trim() === 'Preço Promoção');
        const colDiaPromoIndex = cabecalho.findIndex(c => c && c.trim() === 'Dia da Promoção');
        const colHoraInicioIndex = cabecalho.findIndex(c => c && c.trim() === 'Hora Início');
        const colHoraFimIndex = cabecalho.findIndex(c => c && c.trim() === 'Hora Fim');
        async function atualizar(idx, val) { if (val && val !== "" && idx !== -1) await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${getColLetter(idx)}${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[val]] } }); }
        async function limpar(idx) { if (idx !== -1) await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: `${getColLetter(idx)}${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[""]] } }); }
        if (limpar_promo) {
            await limpar(colPrecoPromoIndex); await limpar(colDiaPromoIndex); await limpar(colHoraInicioIndex); await limpar(colHoraFimIndex);
        } else {
            await atualizar(colPrecoIndex, preco); await atualizar(colTempoIndex, tempo); await atualizar(colPrecoPromoIndex, preco_promo); await atualizar(colDiaPromoIndex, dia_promo); await atualizar(colHoraInicioIndex, hora_inicio); await atualizar(colHoraFimIndex, hora_fim);
        }
        setTimeout(sincronizarPrecosPlanilhas, 1000);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: "Erro Planilha" }); }
});

// --- 9. STATUS / LOGIN / LOGOUT ---
app.get('/api/status_geral', (req, res) => { res.json(STATUS_CACHE); });
app.post('/login', async (req, res) => {
    const nomeDono = await autenticarUsuarioNaPlanilha(req.body.usuario, req.body.senha);
    if (nomeDono) { res.cookie('dono', nomeDono, { httpOnly: true, maxAge: 86400000 }); res.redirect('/painel'); } else res.send(`Incorreto. <a href="/painel">Voltar</a>`);
});
app.get('/logout', (req, res) => {
    res.clearCookie('dono', { path: '/' }); res.clearCookie('dono');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0');
    res.send(`<script>window.location.href = '/painel';</script>`);
});

// --- 10. ACIONAR (USA O CÉREBRO PARA SECAR) ---
app.post('/api/acionar', (req, res) => {
    const dono = req.cookies.dono; const { id, cmd } = req.body;
    if (!dono || !CLIENTES[id] || CLIENTES[id].dono !== dono) return res.status(403).json({ error: "Proibido" });
    if (cmd.includes('SECAR:')) {
        let tempoParaSecar = cmd.split(':')[1];
        executarDisparo(id, tempoParaSecar);
    } else {
        mqttClient.publish(`lavanderia/${id}/comandos`, cmd, { qos: 1 });
    }
    res.json({ success: true });
});

// --- 11. TELA DO CLIENTE (DO ADESIVO) ---
app.get('/app/:id', async (req, res) => {
    const id = req.params.id;
    if (!CLIENTES[id]) return res.send("<h2>Erro: Máquina não encontrada.</h2>");
    const config = CLIENTES[id];
    const isSecadora = id.toLowerCase().includes('sec');
    const tipoMaquina = isSecadora ? 'SECADORA' : 'LAVADORA';
    const matchNumeros = id.match(/\d+$/);
    const numeroMaquina = matchNumeros ? matchNumeros[0] : "";
    let tipoPreco = isSecadora ? 'preco_secar' : 'preco_45';
    let botaoFisicoHtml = config.usa_maquininha ? `<button onclick="pagarFisico('${id}','${tipoPreco}')" style="background:#e67e22; margin-top:15px;">💳 PAGAR NA MAQUININHA FÍSICA</button>` : '';
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{text-align:center; font-family:sans-serif; padding:20px; background:#ecf0f1; margin:0;} .box{background:white; padding:20px; border-radius:15px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); margin-bottom: 20px;} button{width:100%; padding:20px; font-size:16px; border-radius:10px; border:none; color:white; font-weight:bold; cursor:pointer; margin-top:10px;} .btn-pix{background:#27ae60;} .btn-online{background:#8e44ad;} .btn-copiar{background:#34495e; padding:15px; font-size:14px;} #areaPix{display:none; margin-top:20px;} #imgPix{width:250px; height:250px; margin:10px auto; border:2px solid #bdc3c7; border-radius:10px; padding:10px;} #textoCopiaCola{width:100%; padding:10px; box-sizing:border-box; font-size:12px; margin-bottom:10px; word-break:break-all; background:#f8f9fa; border:1px solid #ddd; border-radius:5px;}</style></head><body>
        <div class="box"><h1 style="margin:0; color:#2c3e50;">${tipoMaquina} ${numeroMaquina}</h1><p style="color:#7f8c8d; margin-top:5px;">Loja: ${config.dono}</p>
            <div id="areaBotoes">
                <button class="btn-pix" onclick="gerarPix('${id}','${tipoPreco}')">🟢 PAGAR COM PIX (RÁPIDO)</button>
                <button class="btn-online" onclick="pagarOnline('${id}','${tipoPreco}')">💳 PAGAR CARTÃO NO CELULAR</button>
                ${botaoFisicoHtml}
            </div>
            <div id="areaPix">
                <h3 style="color:#27ae60;">Escaneie ou copie o código abaixo:</h3><img id="imgPix" src="" alt="QR Code Pix" /><textarea id="textoCopiaCola" rows="3" readonly></textarea><button class="btn-copiar" onclick="copiarPix()">📋 COPIAR PIX</button><p style="font-size:14px; color:#e67e22; margin-top:15px;">⏳ Aguardando pagamento...</p>
            </div>
            <div id="msgAprovado" style="display:none; margin-top:20px; color:#27ae60; font-weight:bold; font-size:24px;">✅ Pagamento Aprovado! <br><span style="font-size:16px; color:#333;">Sua máquina já foi liberada.</span></div>
        </div>
        <script>
        function gerarPix(id, tempo){
            document.getElementById('areaBotoes').innerHTML = "<p>⏳ Gerando PIX...</p>";
            fetch('/api/gerar_pix', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id_maquina: id, tempo: tempo}) }).then(r => r.json()).then(d => {
                if (d.success) { document.getElementById('areaBotoes').style.display = 'none'; document.getElementById('areaPix').style.display = 'block'; document.getElementById('imgPix').src = "data:image/jpeg;base64," + d.qr_code_base64; document.getElementById('textoCopiaCola').value = d.qr_code; iniciarMonitoramento(id); } else { alert('Erro.'); window.location.reload(); }
            }).catch(e => { window.location.reload(); });
        }
        function pagarOnline(id, tempo){
            document.getElementById('areaBotoes').innerHTML = "<p>⏳ Redirecionando...</p>";
            fetch('/criar_pagamento', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id_maquina: id, tempo: tempo}) }).then(r => r.json()).then(d => {
                if(d.init_point) window.location.href = d.init_point; else window.location.reload();
            }).catch(e => window.location.reload());
        }
        function pagarFisico(id, tempo){
            document.getElementById('areaBotoes').innerHTML = "<p>⏳ Acordando maquininha...</p>";
            fetch('/api/pagar_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: id, tempo: tempo }) }).then(r => r.json()).then(d => {
                if(d.error) { alert("Atenção: " + d.error); window.location.reload(); } else { document.getElementById('areaBotoes').innerHTML = "<div style='font-size:60px;'>💳</div><p style='color:#27ae60; font-weight:bold;'>Insira o cartão na maquininha ao lado!</p>"; iniciarMonitoramento(id); }
            }).catch(e => window.location.reload());
        }
        function copiarPix() { var copyText = document.getElementById("textoCopiaCola"); copyText.select(); navigator.clipboard.writeText(copyText.value).then(() => { alert("PIX copiado!"); }); }
        function iniciarMonitoramento(id) { setInterval(async () => { try { let res = await fetch('/api/status_geral?t=' + new Date().getTime()); let statusCache = await res.json(); let st = statusCache[id] || "DISPONIVEL"; if (st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("TEMPO:") || st.includes("OCUPADA")) { document.getElementById('areaPix').style.display = 'none'; document.getElementById('areaBotoes').style.display = 'none'; document.getElementById('msgAprovado').style.display = 'block'; } } catch(e) {} }, 3000); }
        </script>
    </body></html>`);
});

// --- 12. PAGAMENTO ONLINE (CHECKOUT) ---
app.post('/criar_pagamento', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    id_maquina = id_maquina ? String(id_maquina).trim() : id_maquina;
    if (Object.keys(CLIENTES).length === 0) { await carregarConfiguracoes(); }
    if (tempo === '45' || tempo === 'CMD_45') tempo = 'preco_45'; if (String(tempo).toLowerCase().includes('sec')) tempo = 'preco_secar';
    const config = CLIENTES[id_maquina]; if (!config) return res.status(400).json({ error: "Servidor reiniciando ou máquina não configurada. Tente novamente." });
    if (STATUS_CACHE[id_maquina] && STATUS_CACHE[id_maquina].includes('TEMPO:')) return res.status(400).json({ error: "MÁQUINA EM USO." });
    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero" });
        const preference = {
            items: [{ title: `Ciclo ${dados.tempo}min - ${id_maquina}`, unit_price: parseFloat(dados.preco), quantity: 1, currency_id: 'BRL' }],
            metadata: { maquina: id_maquina, tempo_planilha: dados.tempo }, payer: { email: `cliente_${Date.now()}@lavanderia.com` },
            payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }], installments: 1 },
            notification_url: "https://lavanderia-server.onrender.com/webhook", auto_return: "approved",
            back_urls: { success: "https://lavanderia-server.onrender.com/sucesso", failure: "https://lavanderia-server.onrender.com/erro" }
        };
        const response = await axios.post('https://api.mercadopago.com/checkout/preferences', preference, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
        res.json({ status: 'ok', init_point: response.data.init_point });
    } catch (e) { res.status(500).json({ error: "Erro MP" }); }
});

// --- 13. PIX DIRETO ---
app.post('/api/gerar_pix', async (req, res) => {
    let { id_maquina, tempo } = req.body;
    id_maquina = id_maquina ? String(id_maquina).trim() : id_maquina;
    if (Object.keys(CLIENTES).length === 0) { await carregarConfiguracoes(); }
    if (tempo === '45' || tempo === 'CMD_45') tempo = 'preco_45'; if (String(tempo).toLowerCase().includes('sec')) tempo = 'preco_secar';
    const config = CLIENTES[id_maquina]; if (!config) return res.status(400).json({ error: "Erro. Tente novamente." });
    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero" });
        const paymentData = { transaction_amount: parseFloat(dados.preco), description: `Unileve - ${id_maquina}`, payment_method_id: "pix", payer: { email: `c_${Date.now()}@mail.com` }, metadata: { maquina: id_maquina, tempo_planilha: dados.tempo }, notification_url: "https://lavanderia-server.onrender.com/webhook" };
        const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, { headers: { 'Authorization': `Bearer ${config.token_mp}`, 'X-Idempotency-Key': `${id_maquina}-${Date.now()}` } });
        res.json({ success: true, qr_code_base64: response.data.point_of_interaction.transaction_data.qr_code_base64, qr_code: response.data.point_of_interaction.transaction_data.qr_code });
    } catch (e) { res.status(500).json({ error: "Erro Pix" }); }
});

// --- 14. WEBHOOK ---
app.post('/webhook', async (req, res) => {
    const info = req.body;
    let tipoEvento = req.query.type || (info && info.type) || (info && info.action) || req.query.topic;

    if (tipoEvento === 'point_integration_wh' || (info && info.state && String(info.state).toUpperCase() === 'FINISHED' && info.payment)) {
        if (info.payment && info.payment.state && String(info.payment.state).toUpperCase() === 'APPROVED' && info.additional_info && info.additional_info.external_reference) {
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
                        if (response.data.metadata && response.data.metadata.maquina) {
                            maquina = response.data.metadata.maquina;
                            tempo = response.data.metadata.tempo_planilha || "45";
                        } else if (response.data.external_reference && response.data.external_reference.includes('|')) {
                            const partes = response.data.external_reference.split('|'); maquina = partes[0]; tempo = partes[1];
                        }
                        if (maquina) { executarDisparo(maquina, tempo); return res.sendStatus(200); }
                    }
                } catch (err) {}
            }
        }
    }
    res.sendStatus(200);
});

// --- 15. MAQUININHA FÍSICA ---
app.post('/api/pagar_fisico', async (req, res) => {
    let { id_maquina, tempo } = req.body; 
    id_maquina = id_maquina ? String(id_maquina).trim() : id_maquina;
    if (Object.keys(CLIENTES).length === 0) { await carregarConfiguracoes(); }
    const config = CLIENTES[id_maquina];
    if (!config || !config.device_id) return res.status(400).json({ error: "Servidor reiniciando ou máquina não configurada. Tente novamente." });
    if (INTENTS_ATIVOS[id_maquina]) { try { await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents/${INTENTS_ATIVOS[id_maquina]}`, { headers: { 'Authorization': `Bearer ${config.token_mp}` } }); } catch(e) {} delete INTENTS_ATIVOS[id_maquina]; }
    try {
        const dados = await buscarDadosNaPlanilha(config.sheet_id, id_maquina, tempo);
        if (parseFloat(dados.preco) <= 0) return res.status(400).json({ error: "Preço zero." });
        const ordemPagamento = { amount: Math.round(parseFloat(dados.preco) * 100), description: `Unileve - ${id_maquina}`, additional_info: { external_reference: `${id_maquina}|${dados.tempo}`, print_on_terminal: false } };
        const response = await axios.post(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, ordemPagamento, { headers: { 'Authorization': `Bearer ${config.token_mp}` } });
        INTENTS_ATIVOS[id_maquina] = response.data.id; res.json({ success: true, intent_id: response.data.id });
    } catch (error) { res.status(500).json({ error: "Erro na maquininha." }); }
});

app.post('/api/cancelar_fisico', async (req, res) => {
    const { id_maquina } = req.body; const config = CLIENTES[id_maquina]; const intentId = INTENTS_ATIVOS[id_maquina];
    if (!config || !intentId) return res.json({ success: false });
    try { await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents/${intentId}`, { headers: { 'Authorization': `Bearer ${config.token_mp}` } }); delete INTENTS_ATIVOS[id_maquina]; } catch (e) {}
    res.json({ success: true });
});

app.get('/limpar-fila/:id_maquina', async (req, res) => {
    const id = req.params.id_maquina; const config = CLIENTES[id];
    if (!config || !config.device_id) return res.send("Máquina sem DEVICE_ID");
    try { await axios.delete(`https://api.mercadopago.com/point/integration-api/devices/${config.device_id}/payment-intents`, { headers: { 'Authorization': `Bearer ${config.token_mp}` } }); res.send("<h2 style='color:green;'>✅ Fila limpa!</h2>"); } catch (error) { res.send("<p>" + error.message + "</p>"); }
});

// --- 16. TOTEM COMPACTO PARA TABLET (HORIZONTAL) ---
app.get('/totem/:donoUrl', (req, res) => {
    const donoRequisitado = req.params.donoUrl.toLowerCase();
    let maquinasDaLoja = Object.keys(CLIENTES).filter(id => CLIENTES[id].dono.toLowerCase() === donoRequisitado);
    if (maquinasDaLoja.length === 0) return res.send("<h1 style='text-align:center; font-family:sans-serif; margin-top:50px; color:#2c3e50;'>Nenhuma máquina encontrada para esta loja.</h1>");
    
    // Separa e ordena as máquinas por tipo
    let secadoras = maquinasDaLoja.filter(id => id.toLowerCase().includes('sec')).sort((a,b) => a.localeCompare(b));
    let lavadoras = maquinasDaLoja.filter(id => !id.toLowerCase().includes('sec')).sort((a,b) => a.localeCompare(b));

    function gerarBotao(idOriginal, isSecadora) {
        if (!idOriginal) return '';
        let numMatch = idOriginal.match(/\d+$/);
        let numero = numMatch ? numMatch[0] : idOriginal.toUpperCase();
        let nomeAmigavel = (isSecadora ? 'SECADORA ' : 'LAVADORA ') + numero;
        let icone = isSecadora ? '🔥' : '💧';
        let st = STATUS_CACHE[idOriginal] || "DISPONIVEL";
        let isOcupada = st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("ENXAGUE") || st.includes("CENTRIF") || st.includes("OCUPADA");
        
        let cssClasse = isOcupada ? 'ocupada' : (isSecadora ? 'secadora-livre' : 'lavadora-livre');
        let evento = isOcupada ? `alert('Esta máquina já está lavando roupas de outro cliente!')` : `abrirConfirmacao('${nomeAmigavel}', '${idOriginal}')`;
        let textoBadge = isOcupada ? "EM USO ⏳" : "TOCAR PARA PAGAR";

        return `<div id="${idOriginal}" class="botao-maq ${cssClasse}" onclick="${evento}">
            <div style="font-size:50px;">${icone}</div>
            <h2 style="margin:8px 0; font-size:20px;">${nomeAmigavel}</h2>
            <div id="badge-${idOriginal}" style="background:rgba(0,0,0,0.2); border-radius:6px; padding:8px; font-size:14px; font-weight:bold;">${textoBadge}</div>
        </div>`;
    }

    let htmlSecadoras = `<div class="linha-maquinas">` + secadoras.map(id => gerarBotao(id, true)).join('') + `</div>`;
    let htmlLavadoras = `<div class="linha-maquinas">` + lavadoras.map(id => gerarBotao(id, false)).join('') + `</div>`;
    let htmlTotem = htmlSecadoras + htmlLavadoras;

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Unileve - Autoatendimento</title>
        <style>
            body { font-family: sans-serif; background: #ecf0f1; margin: 0; padding: 10px; user-select: none; overflow-x: hidden; }
            h1 { text-align: center; color: #2c3e50; font-size: 26px; margin-bottom: 2px; margin-top: 5px; }
            p.subtitulo { text-align: center; color: #7f8c8d; font-size: 16px; margin-bottom: 15px; margin-top: 0; }
            
            .loja-container { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; width: 100%; max-width: 1000px; margin: 0 auto; }
            .linha-maquinas { display: flex; flex-direction: row; justify-content: center; gap: 15px; width: 100%; flex-wrap: wrap; }
            
            .botao-maq { border-radius:12px; padding:15px; color:white; text-align:center; cursor:pointer; box-shadow: 0 4px 8px rgba(0,0,0,0.15); transition: transform 0.1s; flex: 1; max-width: 210px; min-width: 150px; }
            .botao-maq:active { transform: scale(0.97); }
            .secadora-livre { background: #e67e22; }
            .lavadora-livre { background: #2980b9; }
            .ocupada { background: #95a5a6; opacity: 0.6; cursor: not-allowed; }
            
            .overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 1000; color: white; text-align: center; justify-content: center; align-items: center; flex-direction: column; overflow-y: auto; }
            .btn-acao { padding: 15px 30px; font-size: 16px; font-weight: bold; color: white; border: none; border-radius: 8px; cursor: pointer; margin: 5px; }
            .btn-sim { background: #2ecc71; }
            .btn-nao { background: #e74c3c; }
            
            .btn-escolha { padding: 15px; font-size: 18px; border-radius: 12px; width: 100%; max-width: 300px; border: none; color: white; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; flex: 1; }
            .btn-cartao { background: #e67e22; }
            .btn-cartao:active { background: #d35400; }
            .btn-pix { background: #27ae60; }
            .btn-pix:active { background: #2ecc71; }
        </style>
    </head>
    <body>
        <h1>Bem-vindo à Unileve</h1>
        <p class="subtitulo">Toque na máquina que você deseja usar:</p>
        <div class="loja-container">${htmlTotem}</div>
        
        <div id="telaConfirmacao" class="overlay">
            <div style="font-size:45px; margin-bottom: 5px;">👕</div>
            <h2 style="font-size:24px; color:#f1c40f; margin:0 0 10px 0;">ATENÇÃO</h2>
            <p style="font-size:18px; max-width:600px; line-height:1.2; margin: 10px 0;">Você já colocou as roupas na <b id="maqConfirmacao">MÁQUINA</b> e fechou a porta?</p>
            <p style="font-size:13px; color:#e74c3c; background: rgba(231, 76, 60, 0.2); padding: 10px; border-radius: 8px; margin: 10px 0 15px 0;">⚠️ Após o pagamento aprovado, a máquina iniciará automaticamente.</p>
            <div style="display: flex; gap: 15px;">
                <button class="btn-acao btn-nao" onclick="cancelarTudo()">NÃO, VOU COLOCAR</button>
                <button class="btn-acao btn-sim" onclick="irParaEscolha()">SIM, JÁ COLOQUEI</button>
            </div>
        </div>
        
        <div id="telaEscolha" class="overlay">
            <h2 style="font-size:26px; margin-bottom: 20px; color:#fff;">Como deseja pagar?</h2>
            <div style="display: flex; justify-content: center; gap: 15px; width: 100%; max-width: 600px; margin-bottom: 15px;">
                <button class="btn-escolha btn-cartao" onclick="pagarComCartao()"><span style="font-size: 30px;">💳</span> <span style="font-size: 16px;">CARTÃO<br><span style="font-size:12px; font-weight:normal;">Na maquininha</span></span></button>
                <button class="btn-escolha btn-pix" onclick="pagarComPixTotem()"><span style="font-size: 30px;">🟢</span> <span style="font-size: 16px;">PIX<br><span style="font-size:12px; font-weight:normal;">Ler na tela</span></span></button>
            </div>
            <button class="btn-acao btn-nao" style="margin-top:10px; background: transparent; border: 2px solid #e74c3c; padding: 10px 25px;" onclick="cancelarTudo()">CANCELAR</button>
        </div>
        
        <div id="telaPagamento" class="overlay">
            <div style="font-size:60px; margin-top: 10px;">💳</div>
            <h2 style="font-size:24px; margin:10px 0;">Vá até a maquininha ao lado!</h2>
            <p style="font-size:18px; color:#bdc3c7; margin:5px 0;">Aproxime ou insira seu cartão para liberar a <br><b id="maqAlvoCartao" style="color:#2ecc71; font-size:22px; display:inline-block; margin-top:5px;">MÁQUINA</b>.</p>
            <button class="btn-acao btn-nao" style="margin-top:20px; padding: 15px 30px;" onclick="cancelarTudo()">CANCELAR COMPRA</button>
        </div>
        
        <div id="telaPixTotem" class="overlay">
            <div style="display:flex; flex-direction:row; align-items:center; justify-content:center; gap:25px; width:100%; padding:15px; box-sizing:border-box; height:100%;">
                <div style="text-align:left; max-width:50%;">
                    <h2 style="font-size:28px; margin-top:0; margin-bottom:10px; color:#2ecc71;">Pague com PIX</h2>
                    <p style="font-size:16px; color:#bdc3c7; margin-top:0; margin-bottom:10px;">Abra o app do seu banco e escaneie o código.</p>
                    <p style="font-size:14px; color:#f1c40f; margin-bottom: 25px;">A máquina iniciará automaticamente.</p>
                    <button class="btn-acao btn-nao" style="margin:0; background: transparent; border: 2px solid #e74c3c; padding: 12px 20px;" onclick="cancelarTudo()">CANCELAR COMPRA</button>
                </div>
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <div id="loadingPix" style="font-size:16px; color:#f1c40f;">⏳ Gerando código PIX...</div>
                    <img id="imgPixTotem" src="" style="display:none; width:190px; height:190px; border: 6px solid #fff; border-radius:12px; background:white; margin-top:5px;">
                </div>
            </div>
        </div>
        
        <div id="telaSucesso" class="overlay" style="background: rgba(39, 174, 96, 0.95);">
            <div style="font-size:80px; animation: pop 0.5s;">✅</div>
            <h2 style="font-size:32px; margin-top:15px; color:#fff;">PAGAMENTO APROVADO!</h2>
            <p style="font-size:20px; color:#fff; margin-top:10px;">Sua máquina já foi iniciada.</p>
        </div>
        
        <div id="telaErro" class="overlay">
            <div style="font-size:50px;">⚠️</div>
            <h2 style="font-size:26px; color:#ff7675; margin-top:10px;">Maquininha Ocupada!</h2>
            <div style="background: rgba(231, 76, 60, 0.15); border: 2px solid #e74c3c; border-radius: 8px; padding: 15px; max-width: 500px; margin-top: 15px; text-align: center;">
                <p style="font-size:18px; color:#ffffff; margin:0; line-height:1.4;">O cliente anterior não terminou o pagamento.<br><br>Aperte a <b>Seta de Voltar ( < )</b> ou o <b>Botão Vermelho ( X )</b> na própria maquininha para destravar!</p>
            </div>
            <button class="btn-acao btn-nao" style="margin-top:30px; font-size:18px; padding: 15px 30px;" onclick="cancelarTudo()">ENTENDI, VOLTAR</button>
        </div>
     <script>
            let idOriginalAlvo = "";
            let nomeAmigavelAlvo = "";
            let timerCancelamento;
            function abrirConfirmacao(nome, idOriginal) {
                nomeAmigavelAlvo = nome;
                idOriginalAlvo = idOriginal;
                document.getElementById('maqConfirmacao').innerText = nomeAmigavelAlvo;
                document.getElementById('telaConfirmacao').style.display = 'flex';
            }
            function irParaEscolha() {
                document.getElementById('telaConfirmacao').style.display = 'none';
                document.getElementById('telaEscolha').style.display = 'flex';
            }
            function pagarComCartao() {
                document.getElementById('telaEscolha').style.display = 'none';
                document.getElementById('maqAlvoCartao').innerText = nomeAmigavelAlvo;
                document.getElementById('telaPagamento').style.display = 'flex';
                let tipoPreco = idOriginalAlvo.toLowerCase().includes('sec') ? 'preco_secar' : 'preco_45';
                fetch('/api/pagar_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: idOriginalAlvo, tempo: tipoPreco }) })
                .then(r => r.json()).then(d => {
                    if(d.error) {
                        if (d.error.includes("travou")) { document.getElementById('telaPagamento').style.display = 'none'; document.getElementById('telaErro').style.display = 'flex'; }
                        else { alert("Atenção: " + d.error); cancelarTudo(); }
                    }
                }).catch(e => console.log("Comando enviado."));
                iniciarTimerLimpeza();
            }
            function pagarComPixTotem() {
                document.getElementById('telaEscolha').style.display = 'none';
                document.getElementById('telaPixTotem').style.display = 'flex';
                document.getElementById('loadingPix').style.display = 'block';
                document.getElementById('imgPixTotem').style.display = 'none';
                let tipoPreco = idOriginalAlvo.toLowerCase().includes('sec') ? 'preco_secar' : 'preco_45';
                fetch('/api/gerar_pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: idOriginalAlvo, tempo: tipoPreco }) })
                .then(r => r.json()).then(d => {
                    if(d.success) {
                        document.getElementById('loadingPix').style.display = 'none';
                        document.getElementById('imgPixTotem').src = "data:image/jpeg;base64," + d.qr_code_base64;
                        document.getElementById('imgPixTotem').style.display = 'block';
                    } else { alert("Atenção: " + (d.error || "Falha ao gerar PIX")); cancelarTudo(); }
                }).catch(e => { alert("Erro de conexão."); cancelarTudo(); });
                iniciarTimerLimpeza();
            }
            function iniciarTimerLimpeza() {
                clearTimeout(timerCancelamento);
                timerCancelamento = setTimeout(() => {
                    let pagFisicoAberto = document.getElementById('telaPagamento').style.display === 'flex';
                    let pixTotemAberto = document.getElementById('telaPixTotem').style.display === 'flex';
                    if (pagFisicoAberto || pixTotemAberto) { alert("Tempo esgotado. A operação foi cancelada para liberar o totem."); cancelarTudo(); }
                }, 90000);
            }
            function cancelarTudo() {
                clearTimeout(timerCancelamento);
                if (document.getElementById('telaPagamento').style.display === 'flex' && idOriginalAlvo) {
                    fetch('/api/cancelar_fisico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_maquina: idOriginalAlvo }) }).catch(e => console.log("Limpando..."));
                }
                document.getElementById('telaConfirmacao').style.display = 'none';
                document.getElementById('telaEscolha').style.display = 'none';
                document.getElementById('telaPagamento').style.display = 'none';
                document.getElementById('telaPixTotem').style.display = 'none';
                document.getElementById('telaErro').style.display = 'none';
                document.getElementById('telaSucesso').style.display = 'none';
                idOriginalAlvo = "";
                nomeAmigavelAlvo = "";
            }
            setInterval(async () => {
                try {
                    let res = await fetch('/api/status_geral?t=' + new Date().getTime(), { cache: 'no-store' });
                    let statusCache = await res.json();
                    let pagFisicoAberto = document.getElementById('telaPagamento').style.display === 'flex';
                    let pixTotemAberto = document.getElementById('telaPixTotem').style.display === 'flex';
                    if ((pagFisicoAberto || pixTotemAberto) && idOriginalAlvo) {
                        let stAlvo = statusCache[idOriginalAlvo] || "DISPONIVEL";
                        let alvoOcupado = stAlvo.includes("LAVANDO") || stAlvo.includes("SECANDO") || stAlvo.includes("ENXAGUE") || stAlvo.includes("CENTRIF") || stAlvo.includes("OCUPADA");
                        if (alvoOcupado) {
                            document.getElementById('telaPagamento').style.display = 'none';
                            document.getElementById('telaPixTotem').style.display = 'none';
                            document.getElementById('telaSucesso').style.display = 'flex';
                            setTimeout(() => { cancelarTudo(); }, 3500);
                        }
                    }
                    for (let id in statusCache) {
                        let divMaq = document.getElementById(id);
                        let divBadge = document.getElementById('badge-' + id);
                        if (divMaq && divBadge) {
                            let st = statusCache[id] || "DISPONIVEL";
                            let isOcupada = st.includes("LAVANDO") || st.includes("SECANDO") || st.includes("ENXAGUE") || st.includes("CENTRIF") || st.includes("OCUPADA");
                            let isSecadora = id.toLowerCase().includes('sec');
                            let numMatch = id.match(/\d+$/);
                            let numero = numMatch ? numMatch[0] : id.toUpperCase();
                            let nomeAmigavel = (isSecadora ? 'SECADORA ' : 'LAVADORA ') + numero;
                            if (isOcupada) {
                                divMaq.className = "botao-maq ocupada";
                                divMaq.onclick = function() { alert('Esta máquina já está lavando roupas de outro cliente!'); };
                                divBadge.innerText = "EM USO ⏳";
                            } else {
                                divMaq.className = "botao-maq " + (isSecadora ? 'secadora-livre' : 'lavadora-livre');
                                divMaq.onclick = function() { abrirConfirmacao(nomeAmigavel, id); };
                                divBadge.innerText = "TOCAR PARA PAGAR";
                            }
                        }
                    }
                } catch(e) { console.log("Aguardando sync..."); }
            }, 1500);
        </script>
    </body>
    </html>
    `);
});

// --- 17. RETORNO MP ---
app.get('/sucesso', (req, res) => res.send(`<h2>✅ Sucesso!</h2>`));
app.get('/erro', (req, res) => res.send(`<h2>❌ Erro!</h2>`));
// --- 18. OAUTH MP — CONECTAR CONTA DO DONO ---
app.get('/mp-callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Código ausente. Tente novamente.');

    try {
        // Troca o code por access_token + refresh_token
        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: process.env.MP_CLIENT_ID || '',
            client_secret: process.env.MP_CLIENT_SECRET || '',
            code,
            redirect_uri: 'https://lavanderia-server.onrender.com/mp-callback',
        });
        const { data } = await axios.post('https://api.mercadopago.com/oauth/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        // Identifica o dono (via state) ou usa o primeiro da planilha
        const dono = state || (Object.values(CLIENTES)[0] ? Object.values(CLIENTES)[0].dono : null);
        if (!dono) return res.status(400).send('Não foi possível identificar o dono.');

        // Atualiza o token_mp (coluna C) e o refresh_token (coluna J) na planilha
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: 'CONFIG_GERAL!A:B',
        });
        const linhas = response.data.values;
        if (linhas && linhas.length > 1) {
            for (let i = 1; i < linhas.length; i++) {
                if (linhas[i][1] && linhas[i][1].trim() === dono) {
                    const rowNumber = i + 1;
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: MASTER_SHEET_ID,
                        range: `CONFIG_GERAL!C${rowNumber}`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: { values: [[data.access_token]] },
                    });
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: MASTER_SHEET_ID,
                        range: `CONFIG_GERAL!J${rowNumber}`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: { values: [[data.refresh_token]] },
                    });
                }
            }
        }

        // Atualiza o cache em memória
        for (const id in CLIENTES) {
            if (CLIENTES[id].dono === dono) {
                CLIENTES[id].token_mp = data.access_token;
            }
        }
        TOKENS_MP[dono] = {
            access: data.access_token,
            refresh: data.refresh_token,
            expiresAt: Date.now() + (data.expires_in || 21600) * 1000,
        };

        res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;color:#27ae60;">✅ Conta Mercado Pago conectada com sucesso! Já pode fechar esta página.</h2>');
    } catch (e) {
        console.error('❌ Erro no mp-callback:', e.response?.data || e.message);
        res.status(500).send('Erro ao conectar a conta MP. Verifique as credenciais.');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor Pronto na porta ${PORT}`));
