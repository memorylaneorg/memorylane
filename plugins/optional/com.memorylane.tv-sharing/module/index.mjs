import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { interfaces, selectedInterface, sameSubnet } from './network.mjs';
import { startServer } from './server.mjs';
import { createCatalogAdapter } from './catalog.mjs';
import { startDiscovery } from './discovery.mjs';
export async function activate(context) {
    let closed = false, server = null, discovery = null, signature = '', error = null, pending = null;
    const idFile = path.join(context.dataDir, 'device-id');
    await fs.mkdir(context.dataDir, { recursive: true });
    let uuid;
    try {
        uuid = await fs.readFile(idFile, 'utf8');
        if (!/^uuid:[0-9a-f-]{36}$/.test(uuid))
            throw Error();
    }
    catch {
        uuid = `uuid:${randomUUID()}`;
        await fs.writeFile(idFile, uuid, { mode: 0o600 });
    }
    async function close() { discovery?.stop(); discovery = null; await server?.stop(); server = null; signature = ''; }
    async function performRefresh() {
        if (closed)
            return;
        try {
            if (typeof context.callCore !== 'function') {
                error = 'This plugin requires a core with the TV sharing bridge';
                return;
            }
            const config = await context.callCore('tv.config', {});
            if (closed)
                return;
            if (!config.enabled) {
                await close();
                error = null;
                return;
            }
            const network = selectedInterface(config.address), next = JSON.stringify([network, config.port, config.name]);
            if (signature !== next) {
                await close();
                if (closed)
                    return;
                server = await startServer({ address: network.address, port: config.port, uuid, name: config.name, admitPeer: ip => !closed && sameSubnet(ip, network) && interfaces().some(i => i.address === network.address && i.netmask === network.netmask), adapter: createCatalogAdapter((method, payload) => context.callCore(method, payload)) });
                if (closed) {
                    await close();
                    return;
                }
                discovery = await startDiscovery({ network, uuid, location: `${server.base}/description.xml`, onError: () => { error = 'Discovery socket failed'; void close(); } });
                signature = next;
                if (closed) {
                    await close();
                    return;
                }
            }
            server?.update(config.updateId);
            error = null;
        }
        catch (e) {
            await close();
            error = e instanceof Error ? e.message : 'TV sharing failed';
        }
    }
    function refresh() {
        if (pending)
            return pending;
        pending = performRefresh().finally(() => { pending = null; });
        return pending;
    }
    const timer = setInterval(() => void refresh(), 5000);
    timer.unref();
    // Polling reads only core policy. Activation never trusts a persisted plugin
    // address or starts sockets without current, explicit core authorization.
    void refresh();
    return { async call(method) { if (method === 'interfaces')
            return interfaces(); if (method === 'refresh') {
            await pending;
            await refresh();
        }
        else if (method !== 'status')
            throw Error('Unknown method'); return { ready: true, sharing: !!server, error, uuid }; }, async stop() { closed = true; clearInterval(timer); await pending; await close(); } };
}
