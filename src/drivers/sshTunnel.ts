import * as fs from 'fs';
import * as net from 'net';
import { Client } from 'ssh2';
import { SshConfig } from './types';

export interface SshTunnel {
  localPort: number;
  close(): void;
}

/** Abre un túnel SSH con reenvío de puerto local hacia host:port remotos. */
export function openSshTunnel(ssh: SshConfig, secret: string | undefined, remoteHost: string, remotePort: number): Promise<SshTunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let server: net.Server | undefined;
    client.on('ready', () => {
      server = net.createServer(sock => {
        client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, remoteHost, remotePort, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          stream.on('close', () => sock.destroy());
          sock.on('close', () => stream.close());
        });
      });
      server.on('error', e => reject(e));
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as net.AddressInfo;
        resolve({
          localPort: addr.port,
          close: () => { server?.close(); client.end(); }
        });
      });
    });
    client.on('error', e => { server?.close(); reject(new Error('SSH: ' + e.message)); });
    const base = { host: ssh.host, port: ssh.port || 22, username: ssh.user, readyTimeout: 20000, keepaliveInterval: 15000 };
    if (ssh.authType === 'key') {
      if (!ssh.privateKeyPath) { reject(new Error('SSH: falta la ruta de la clave privada.')); return; }
      client.connect({ ...base, privateKey: fs.readFileSync(ssh.privateKeyPath), passphrase: secret || undefined });
    } else {
      client.connect({ ...base, password: secret });
    }
  });
}
