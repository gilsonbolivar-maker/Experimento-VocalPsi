// Envio do áudio para análise.
// No endereço protegido (Cloudflare), o áudio vai direto ao armazenamento do Gemini
// pela rota /api/enviar-audio, e a análise recebe só a referência do arquivo.
// Dentro do AI Studio essa rota não existe; aí o áudio segue embutido, como antes.

export const VERSAO_APP = '1.0.0';

export interface ArquivoEnviado {
  uri: string;
  name: string;
  mimeType: string;
}

export type AudioParaAnalise =
  | { arquivo: ArquivoEnviado }
  | { audioBase64: string; mimeType: string };

export function base64ParaBlob(base64: string, tipo: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: tipo });
}

async function blobParaBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Prepara o áudio para as rotas de análise e transcrição. */
export async function prepararAudio(
  blob: Blob,
  signal?: AbortSignal,
  base64Pronto?: string
): Promise<AudioParaAnalise> {
  const tipo = blob.type || 'audio/wav';
  const res = await fetch('/api/enviar-audio', {
    method: 'POST',
    headers: { 'Content-Type': tipo },
    body: blob,
    signal,
  });
  if (res.status === 404) {
    // Fora do endereço protegido (AI Studio): manda o áudio embutido.
    return { audioBase64: base64Pronto ?? (await blobParaBase64(blob)), mimeType: tipo };
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok || !dados.arquivo) {
    throw new Error(dados.error || 'Não foi possível enviar o áudio para análise.');
  }
  return { arquivo: dados.arquivo as ArquivoEnviado };
}
