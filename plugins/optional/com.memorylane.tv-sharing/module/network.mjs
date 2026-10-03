import os from 'node:os';
import net from 'node:net';
export const normalizeIP = value => value?.replace(/^::ffff:/, '') ?? '';
const integer = value => value.split('.').reduce((n, b) => ((n << 8) | Number(b)) >>> 0, 0);
export function privateIPv4(value) {
    if (net.isIP(value) !== 4)
        return false;
    const [a, b] = value.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function sameSubnet(peer, network) {
    peer = normalizeIP(peer);
    return privateIPv4(peer) && privateIPv4(network.address) && net.isIP(network.netmask) === 4 &&
        ((integer(peer) & integer(network.netmask)) >>> 0) === ((integer(network.address) & integer(network.netmask)) >>> 0);
}
export function interfaces() {
    return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => /^(utun|tun|tap|wg|tailscale|docker|veth|bridge)/i.test(name) ? [] : (entries ?? [])
        .filter(i => !i.internal && i.family === 'IPv4' && privateIPv4(i.address))
        .map(i => ({ name, address: i.address, netmask: i.netmask })));
}
export function selectedInterface(address) {
    const found = interfaces().find(i => i.address === address);
    if (!found)
        throw new Error('Select an available private LAN interface');
    return found;
}
