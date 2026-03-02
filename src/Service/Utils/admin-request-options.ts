import { AxiosRequestConfig } from 'axios';
import https from 'https';

/**
 * Builds HttpService options for calls to the admin instance.
 * Adds the admin API key header (when configured) and preserves the existing self-signed TLS behavior.
 */
export const buildAdminRequestOptions = (overrides?: AxiosRequestConfig): AxiosRequestConfig => {
    const httpsAgent = overrides?.httpsAgent ?? new https.Agent({ rejectUnauthorized: false });
    const apiKey = process.env.ADMIN_INSTANCE_X_API_KEY;

    return {
        httpsAgent,
        ...overrides,
        headers: {
            ...(apiKey ? { 'X-API-KEY': apiKey } : {}),
            ...(overrides?.headers ?? {}),
        },
    };
};
