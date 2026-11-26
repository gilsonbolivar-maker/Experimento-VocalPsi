// Peça do Vocalpsianalise na Cloudflare (endereço vocal.pixelnexo.com.br).
// 1. Serve a tela do app, buscando os arquivos publicados no GitHub Pages.
// 2. Faz o papel do server.ts do AI Studio, chamando o Gemini com a chave
//    guardada como segredo (GEMINI_API_KEY), que nunca vai para o navegador.
// O endereço inteiro fica atrás do Cloudflare Access (lista de e-mails).
// O áudio passa direto para o Google, sem ser lido aqui, e é apagado de lá
// logo depois da análise.

const VERSAO = "1.0.0";
const ORIGEM = "https://gilsonbolivar-maker.github.io";
const BASE = "/Vocalpsianalise/";
const GAPI_PADRAO = "https://generativelanguage.googleapis.com";
// Para testes locais, ORIGEM_TESTE e GAPI_TESTE podem apontar para servidores de mentira.
const gapi = (env) => env.GAPI_TESTE || GAPI_PADRAO;
const origem = (env) => env.ORIGEM_TESTE || ORIGEM;
let CONFIG = null;
let CONFIG_EM = 0;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith("/api/")) {
      if (!req.headers.get("cf-access-jwt-assertion")) return json({ error: "Sem acesso." }, 403);
      try {
        if (p === "/api/saude") return json({ ok: true, versao: VERSAO, chave: !!env.GEMINI_API_KEY });
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (!env.GEMINI_API_KEY) return json({ error: "Chave do Gemini ainda não foi colocada na Cloudflare." }, 500);
        if (p === "/api/enviar-audio") return await enviarAudio(req, env);
        const corpo = await req.json();
        if (p === "/api/transcribe") return await transcrever(corpo, env);
        if (p === "/api/analyze-chunk") return await analisarBloco(corpo, env);
        if (p === "/api/session-summary") return await resumo(corpo, env);
        if (p === "/api/test-case-audio") return await casoDeTeste(corpo, env);
        return json({ error: "Caminho desconhecido." }, 404);
      } catch (e) {
        return erroGemini(e);
      }
    }
    if (p === "/" || p === BASE.slice(0, -1)) return Response.redirect(url.origin + BASE + url.search, 302);
    const caminho = p.startsWith(BASE) ? p : BASE.slice(0, -1) + p;
    const res = await fetch(origem(env) + caminho + url.search, { cf: { cacheTtl: 60 } });
    const h = new Headers(res.headers);
    h.set("x-robots-tag", "noindex");
    h.set("permissions-policy", "microphone=(self)");
    return new Response(res.body, { status: res.status, headers: h });
  },
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function config(env) {
  if (CONFIG && Date.now() - CONFIG_EM < 300000) return CONFIG;
  const r = await fetch(origem(env) + BASE + "servidor/config.json", { cf: { cacheTtl: 60 } });
  if (!r.ok) throw Object.assign(new Error("Configuração do servidor não encontrada."), { status: 500 });
  CONFIG = await r.json();
  CONFIG_EM = Date.now();
  return CONFIG;
}

function erroGemini(e) {
  const raw = String((e && e.message) || e);
  const st = (e && e.status) || 0;
  const t = raw.toLowerCase();
  if (st === 429 || t.includes("resource_exhausted") || t.includes("quota"))
    return json({ error: "Limite da API atingido no momento. Aguarde alguns segundos ou verifique a cota da conta." }, 429);
  if (st === 403 || t.includes("api_key_invalid") || t.includes("permission_denied") || t.includes("api key not valid"))
    return json({ error: "Chave da API do Gemini inválida ou sem permissão. Confira a chave colocada na Cloudflare." }, 403);
  if (st === 503 || t.includes("unavailable") || t.includes("overloaded"))
    return json({ error: "O modelo de análise está temporariamente sobrecarregado. Tente novamente em alguns segundos." }, 503);
  if (st === 500 && raw.length < 120) return json({ error: raw }, 500);
  return json({ error: "Erro ao consultar o modelo de análise de áudio: " + raw.slice(0, 300) }, 502);
}

async function gemini(env, modelo, corpo, versao = "v1beta") {
  for (let t = 1; t <= 4; t++) {
    const r = await fetch(`${gapi(env)}/${versao}/models/${modelo}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(corpo),
    });
    if (r.ok) return r;
    const txt = await r.text();
    if (r.status === 503 && t < 4) { await espera(1500 * t); continue; }
    throw Object.assign(new Error(txt), { status: r.status });
  }
}

async function geminiJson(env, modelo, corpo, versao) {
  return (await gemini(env, modelo, corpo, versao)).json();
}

function textoDe(resp) {
  return ((resp && resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts) || [])
    .map((x) => x.text || "").join("").trim();
}

function parteAudio(b) {
  if (b.arquivo && b.arquivo.uri) return { fileData: { fileUri: b.arquivo.uri, mimeType: b.arquivo.mimeType || "audio/wav" } };
  if (typeof b.audioBase64 === "string" && b.audioBase64) return { inlineData: { mimeType: b.mimeType || "audio/wav", data: b.audioBase64 } };
  return null;
}

async function apagarArquivo(env, arquivo) {
  if (!arquivo || !arquivo.name) return;
  try { await fetch(`${gapi(env)}/v1beta/${arquivo.name}`, { method: "DELETE", headers: { "x-goog-api-key": env.GEMINI_API_KEY } }); } catch (e) { /* o Google apaga sozinho em 48 h */ }
}

// Recebe o áudio cru e repassa direto ao armazenamento de arquivos do Gemini, sem ler aqui.
async function enviarAudio(req, env) {
  const tipo = (req.headers.get("content-type") || "audio/wav").split(";")[0];
  const tam = req.headers.get("content-length");
  if (!tam || !req.body) return json({ error: "Áudio vazio ou sem tamanho." }, 411);
  const ini = await fetch(`${gapi(env)}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": tam,
      "X-Goog-Upload-Header-Content-Type": tipo,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "bloco-sessao" } }),
  });
  if (!ini.ok) throw Object.assign(new Error(await ini.text()), { status: ini.status });
  const destino = ini.headers.get("x-goog-upload-url");
  const { readable, writable } = new FixedLengthStream(Number(tam));
  req.body.pipeTo(writable);
  const up = await fetch(destino, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" },
    body: readable,
  });
  if (!up.ok) throw Object.assign(new Error(await up.text()), { status: up.status });
  let f = (await up.json()).file;
  for (let i = 0; i < 20 && f && f.state === "PROCESSING"; i++) {
    await espera(1000);
    f = await (await fetch(`${gapi(env)}/v1beta/${f.name}`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } })).json();
  }
  if (!f || f.state === "FAILED") return json({ error: "O Google não conseguiu ler este áudio." }, 422);
  return json({ arquivo: { uri: f.uri, name: f.name, mimeType: f.mimeType || tipo } });
}

async function transcrever(b, env) {
  const audio = parteAudio(b);
  if (!audio) return json({ error: "Áudio ausente ou inválido para transcrição." }, 400);
  const c = await config(env);
  try {
    const r = await geminiJson(env, c.modelos.TRANSCRIBE_MODEL, {
      contents: [{ role: "user", parts: [audio, { text: c.instrucaoTranscricao }] }],
    });
    const transcription = textoDe(r);
    if (!transcription) return json({ error: "Áudio sem fala detectável para transcrição." }, 422);
    return json({ transcription });
  } finally {
    await apagarArquivo(env, b.arquivo);
  }
}

function blocoValido(d) {
  if (!d || typeof d !== "object") return false;
  if (!["boa", "moderada", "baixa"].includes(d.qualidade_audio_percebida)) return false;
  if (typeof d.observacao_audio !== "string" || !Array.isArray(d.fatores_nao_emocionais_identificados) || !Array.isArray(d.trechos)) return false;
  for (const s of d.trechos) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.inicio !== "string" || !/^\d{1,3}:\d{2}$/.test(s.inicio.trim())) return false;
    if (typeof s.fim !== "string" || !/^\d{1,3}:\d{2}$/.test(s.fim.trim())) return false;
    if (s.falante !== "Psicóloga" && s.falante !== "Paciente") return false;
    if (typeof s.transcricao !== "string" || !s.transcricao.trim()) return false;
    if (!Array.isArray(s.temas) || !Array.isArray(s.emocoes) || !Array.isArray(s.sinais_para_investigar)) return false;
    if (!s.marcadores_da_voz || !s.congruencia || !s.alerta_de_risco) return false;
    if (s.congruencia.status !== "combina" && s.congruencia.status !== "nao_combina") return false;
    if (s.alerta_de_risco.status !== "sim" && s.alerta_de_risco.status !== "não") return false;
  }
  return true;
}

async function analisarBloco(b, env) {
  const audio = parteAudio(b);
  if (!audio) return json({ error: "Áudio do bloco ausente ou inválido." }, 400);
  const c = await config(env);
  const linhas = [
    `Analise este bloco de áudio da sessão terapêutica (Bloco ${b.blockIndex || 1} de ${b.totalBlocks || 1}).`,
    "Os tempos inicio e fim de cada trecho devem ser relativos ao início deste bloco no formato MM:SS.",
    b.acousticSummary ? `Medidas acústicas objetivas calculadas localmente neste aparelho (Web Audio): ${JSON.stringify(b.acousticSummary)}` : "",
    b.baselineContext
      ? `Linha de base vocal dos primeiros minutos do paciente: ${b.baselineContext}. Compare mudanças vocais em relação a essa linha de base do próprio paciente.`
      : "Este é o bloco inicial da sessão: observe atentamente os primeiros minutos da fala do paciente para estabelecer sua linha de base vocal natural.",
    b.nonEmotionalNotes ? `Fatores contextuais informados pela psicóloga: ${b.nonEmotionalNotes}.` : "",
    b.verbatimTranscript ? `Transcrição prévia de apoio (use o áudio diretamente para tom, pausas e emoções): ${b.verbatimTranscript}` : "",
    "Lembre-se: use apenas linguagem de hipótese, cite evidências concretas da voz e nunca diagnostique.",
  ].filter(Boolean).join("\n\n");

  const chamar = async (extra) => {
    const r = await geminiJson(env, c.modelos.ANALYSIS_MODEL, {
      contents: [{ role: "user", parts: [audio, { text: extra ? `${linhas}\n\nATENÇÃO: ${extra}` : linhas }] }],
      systemInstruction: { parts: [{ text: c.instrucaoAnalise }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: c.formatoBloco,
        thinkingConfig: { thinkingLevel: "MEDIUM" },
      },
    });
    return JSON.parse(textoDe(r));
  };

  try {
    let dados = null;
    try { dados = await chamar(); } catch (e) { if (e && e.status) throw e; dados = null; }
    if (!blocoValido(dados)) {
      dados = await chamar("A resposta anterior veio incompleta. Garanta todos os campos obrigatórios do JSON válidos para cada trecho.");
      if (!blocoValido(dados)) return json({ error: "O modelo retornou dados incompletos após nova tentativa. Tente analisar novamente." }, 502);
    }
    return json(dados);
  } finally {
    await apagarArquivo(env, b.arquivo);
  }
}

async function resumo(b, env) {
  if (!Array.isArray(b.trechos) || !b.trechos.length) return json({ error: "Não há trechos analisados para gerar o resumo." }, 400);
  const c = await config(env);
  const compacto = b.trechos.map((t) => ({
    inicio: t.inicio, fim: t.fim, falante: t.falante, transcricao: t.transcricao, emocoes: t.emocoes,
    congruencia: t.congruencia, sinais_para_investigar: t.sinais_para_investigar, alerta_de_risco: t.alerta_de_risco,
  }));
  const m = b.medidasAcusticas || {};
  const prompt = [
    "Com base nos trechos analisados e nas medidas acústicas abaixo, gere um resumo clínico de apoio em português do Brasil.",
    'Regras obrigatórias: não faça diagnóstico; use sempre linguagem de hipótese ("a voz sugere", "há sinais de", "pode indicar"); inclua um parágrafo curto de panorama emocional, os momentos-chave com tempo e evidência vocal, comparação com a linha de base inicial do paciente, fatores não emocionais/confundidores e perguntas prioritárias para a próxima sessão.',
    `Contexto informado: ${b.fatoresContextoInformados || "Nenhum informado."}`,
    `Fatores não emocionais observados: ${JSON.stringify(b.fatoresNaoEmocionais || [])}`,
    `Medidas acústicas objetivas (geral e linha de base): ${JSON.stringify({ geral: m.geral, linhaDeBase: m.linhaDeBase, qualidadeAudio: m.qualidadeAudio })}`,
    `Trechos da sessão: ${JSON.stringify(compacto)}`,
  ].join("\n\n");
  const r = await geminiJson(env, c.modelos.ANALYSIS_MODEL, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: c.instrucaoResumo }] },
    generationConfig: { responseMimeType: "application/json", responseSchema: c.formatoResumo, thinkingConfig: { thinkingLevel: "LOW" } },
  });
  return json(JSON.parse(textoDe(r) || "{}"));
}

// Pega o áudio da resposta sem ler o texto inteiro, para não pesar no processamento.
function audioDaResposta(txt) {
  const i = txt.indexOf('"data"');
  if (i < 0) return "";
  const a = txt.indexOf('"', txt.indexOf(":", i) + 1);
  const z = txt.indexOf('"', a + 1);
  return a > 0 && z > a ? txt.slice(a + 1, z) : "";
}

async function casoDeTeste(b, env) {
  const c = await config(env);
  const caso = c.casos[b.caseId];
  if (!caso) return json({ error: "Caso de teste inválido." }, 400);
  let audio = "";
  try {
    const r = await gemini(env, c.modelos.TTS_MODEL, {
      contents: [{ role: "user", parts: caso.parts }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: caso.speakerConfigs } } },
    }, "v1alpha");
    audio = audioDaResposta(await r.text());
  } catch (e) {
    const r = await gemini(env, c.modelos.TTS_MODEL, {
      contents: [{ role: "user", parts: [{ text: caso.plainPrompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } } } },
    }, "v1alpha");
    audio = audioDaResposta(await r.text());
  }
  if (!audio) return json({ error: "Não foi possível gerar o áudio do caso fictício." }, 502);
  return new Response(`{"audioBase64":"${audio}","mimeType":"audio/wav"}`, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
