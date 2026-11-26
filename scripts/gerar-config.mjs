// Gera public/servidor/config.json a partir do server.ts original do AI Studio.
// Assim a peça da Cloudflare (cloudflare/worker.js) usa exatamente as mesmas
// instruções, formatos de resposta e casos de teste do servidor original.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const Type = { OBJECT: 'OBJECT', STRING: 'STRING', ARRAY: 'ARRAY', INTEGER: 'INTEGER', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' };

function trecho(inicio, fim) {
  const a = src.indexOf(inicio);
  const b = src.indexOf(fim, a);
  if (a < 0 || b < 0) throw new Error(`Não achei o trecho entre "${inicio}" e "${fim}"`);
  return src.slice(a, b);
}

const modelos = Object.fromEntries(
  [...src.matchAll(/const (ANALYSIS_MODEL|TRANSCRIBE_MODEL|TTS_MODEL) = '([^']+)'/g)].map((m) => [m[1], m[2]])
);

const constantes = trecho('const BLOCK_RESPONSE_SCHEMA', 'function validateParsedBlock')
  + trecho('const SYSTEM_INSTRUCTION_ANALYSIS', 'async function startServer');
const { BLOCK_RESPONSE_SCHEMA, SUMMARY_RESPONSE_SCHEMA, SYSTEM_INSTRUCTION_ANALYSIS } = new Function(
  'Type',
  `${constantes}\nreturn { BLOCK_RESPONSE_SCHEMA, SUMMARY_RESPONSE_SCHEMA, SYSTEM_INSTRUCTION_ANALYSIS };`
)(Type);

const blocoCasos = trecho("if (caseId === 'neutra')", "} else {\n        res.status(400)") + '}';
const casos = new Function(`
  const casos = {};
  for (const caseId of ['neutra', 'triste_pausas', 'incongruencia_embargada']) {
    let parts = [], plainPrompt = '', speakerConfigs = [];
    ${blocoCasos}
    casos[caseId] = { parts, plainPrompt, speakerConfigs };
  }
  return casos;
`)();

const config = {
  gerado: new Date().toISOString(),
  modelos,
  instrucaoAnalise: SYSTEM_INSTRUCTION_ANALYSIS,
  instrucaoResumo:
    'Você é um assistente de síntese clínica para psicólogas. Nunca diagnostique; escreva apenas hipóteses apoiadas em evidências vocais e verbais.',
  instrucaoTranscricao:
    'Transcreva fielmente este áudio em português do Brasil, preservando pausas longas (...), hesitações e repetições.',
  formatoBloco: BLOCK_RESPONSE_SCHEMA,
  formatoResumo: SUMMARY_RESPONSE_SCHEMA,
  casos,
};

fs.mkdirSync(new URL('../public/servidor/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../public/servidor/config.json', import.meta.url), JSON.stringify(config, null, 2));
console.log('config.json gerado:', Object.keys(config.casos).join(', '), '| modelos:', JSON.stringify(modelos));
