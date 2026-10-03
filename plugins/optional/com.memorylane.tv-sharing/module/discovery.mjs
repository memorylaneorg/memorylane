import dgram from 'node:dgram';
import { sameSubnet } from './network.mjs';
import { CD, CM, DEVICE } from './protocol.mjs';
const GROUP = '239.255.255.250', PORT = 1900, SERVER = 'Node.js/20 UPnP/1.0 MemoryLane/1.0';
export const targets = uuid => [['upnp:rootdevice', `${uuid}::upnp:rootdevice`], [uuid, uuid], [DEVICE, `${uuid}::${DEVICE}`], [CD, `${uuid}::${CD}`], [CM, `${uuid}::${CM}`]];
export async function startDiscovery({ network, uuid, location, onError }) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let stopped = false;
    const timers = new Set();
    const send = (message, port = PORT, address = GROUP) => { if (!stopped)
        socket.send(message, port, address, () => { }); };
    const announce = state => { for (const [type, usn] of targets(uuid))
        send(`NOTIFY * HTTP/1.1\r\nHOST: ${GROUP}:${PORT}\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${location}\r\nNT: ${type}\r\nNTS: ssdp:${state}\r\nSERVER: ${SERVER}\r\nUSN: ${usn}\r\n\r\n`); };
    socket.on('message', (bytes, peer) => {
        if (stopped || bytes.length > 4096 || !sameSubnet(peer.address, network) || timers.size >= 100)
            return;
        const lines = bytes.toString('utf8').split('\r\n');
        if (lines[0] !== 'M-SEARCH * HTTP/1.1')
            return;
        const h = {};
        for (const l of lines.slice(1)) {
            const i = l.indexOf(':');
            if (i > 0)
                h[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
        }
        if (h.man !== '"ssdp:discover"' || !/^\d+$/.test(h.mx ?? ''))
            return;
        const wait = Math.min(Number(h.mx), 5) * 1000;
        const matches = targets(uuid).filter(([type]) => h.st === 'ssdp:all' || h.st === type);
        if (!matches.length)
            return;
        const timer = setTimeout(() => { timers.delete(timer); for (const [type, usn] of matches)
            send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${location}\r\nSERVER: ${SERVER}\r\nST: ${type}\r\nUSN: ${usn}\r\n\r\n`, peer.port, peer.address); }, Math.random() * wait);
        timers.add(timer);
    });
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(PORT, () => { try {
        socket.addMembership(GROUP, network.address);
        socket.setMulticastInterface(network.address);
        socket.setMulticastTTL(2);
        resolve();
    }
    catch (e) {
        socket.close();
        reject(e);
    } }); });
    socket.on('error', error => onError?.(error));
    announce('alive');
    const interval = setInterval(() => announce('alive'), 600000);
    interval.unref();
    return { stop() { if (stopped)
            return; announce('byebye'); stopped = true; clearInterval(interval); for (const t of timers)
            clearTimeout(t); socket.close(); } };
}
