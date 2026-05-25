import https from 'node:https';

const GATEWAY_BASE_URL = 'https://api.kilo.ai';
// KiloCode gateway endpoint: https://kilo.ai/docs/gateway/models-and-providers
const MODELS_PATH = '/api/gateway/models';
const REQUEST_TIMEOUT_MS = 8_000;
const ERROR_BODY_PREVIEW_LIMIT = 500;

interface GatewayModelObject {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  display_name?: string;
}

interface GatewayModelsResponse {
  object?: string;
  data?: GatewayModelObject[];
}

export interface KilocodeGatewayModel {
  id: string;
  displayName: string;
}

function sanitizeErrorBody(body: string): string {
  const sanitized = body
    .trim()
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-api-key]');
  if (!sanitized) {
    return 'empty response body';
  }
  return sanitized.length > ERROR_BODY_PREVIEW_LIMIT
    ? `${sanitized.slice(0, ERROR_BODY_PREVIEW_LIMIT)}...`
    : sanitized;
}

export class KilocodeGatewayClient {
  async listModels(apiKey: string): Promise<KilocodeGatewayModel[]> {
    const raw = await this.fetchModels(apiKey);
    const items = raw.data ?? [];
    return items
      .filter(
        (item): item is GatewayModelObject & { id: string } =>
          typeof item.id === 'string' && item.id.trim().length > 0
      )
      .map((item) => ({
        id: item.id.trim(),
        displayName: (item.display_name ?? item.id).trim(),
      }));
  }

  private fetchModels(apiKey: string): Promise<GatewayModelsResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(MODELS_PATH, GATEWAY_BASE_URL);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `KiloCode gateway responded with HTTP ${res.statusCode}: ${sanitizeErrorBody(body)}`
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(body) as GatewayModelsResponse);
          } catch {
            reject(
              new Error(`KiloCode gateway returned non-JSON response: ${sanitizeErrorBody(body)}`)
            );
          }
        });
        res.on('error', reject);
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`KiloCode gateway request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });

      req.on('error', reject);
      req.end();
    });
  }
}
