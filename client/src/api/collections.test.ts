import { afterEach, expect, it, vi } from 'vitest';
import { api } from './client';
afterEach(() => vi.unstubAllGlobals());
it('adds a large selection in bounded batches and safely retries after an error', async () => {
    const requests: number[][] = [];
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const ids = JSON.parse(init.body as string).mediaIds;
        requests.push(ids);
        if (requests.length === 2 && fail) {
            fail = false;
            return { ok: false, status: 503, json: async () => ({ error: 'Retry' }) };
        }
        return { ok: true, json: async () => ({ added: ids.length }) };
    }));
    const ids = Array.from({ length: 2001 }, (_, i) => i + 1);
    await expect(api.collections.add(1, { mediaIds: ids })).rejects.toThrow('Retry');
    expect(requests.map(a => a.length)).toEqual([1000, 1000]);
    await expect(api.collections.add(1, { mediaIds: ids })).resolves.toEqual({ added: 2001 });
    expect(requests.slice(2).flat()).toEqual(ids);
});
it('sends folder snapshot scope once without enumerating only the loaded grid', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async () => ({ added: 3500 }) }));
    vi.stubGlobal('fetch', fetch);
    expect(await api.collections.add(2, { folderId: 9, recursive: true })).toEqual({ added: 3500 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ folderId: 9, recursive: true });
});
