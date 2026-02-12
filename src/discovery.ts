import { Device } from './types';
import { createSocket, Socket } from 'dgram';
import { networkInterfaces } from 'os';
import { EventEmitter } from 'events';

const DISCOVERY_PORT = 41234;
const DISCOVERY_MESSAGE = 'NYASHARE_DISCOVER';
const DISCOVERY_INTERVAL = 5000;

export class DeviceDiscovery extends EventEmitter {
  private socket: Socket | null = null;
  private devices: Map<string, Device> = new Map();
  private broadcastInterval: NodeJS.Timeout | null = null;
  private deviceName: string;
  private port: number;
  private localIp: string = '';
  private debug: boolean = process.env.DEBUG === 'true';
  private boundPort: number = DISCOVERY_PORT;

  constructor(deviceName: string, port: number) {
    super();
    this.deviceName = deviceName;
    this.port = port;
    this.localIp = this.getLocalIp();
  }

  private log(...args: any[]): void {
    if (this.debug) {
      console.log('[Discovery]', ...args);
    }
  }

  private getLocalIp(): string {
    const nets = networkInterfaces();
    const candidates: { name: string; address: string; priority: number }[] = [];

    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          let priority = 0;
          const lowerName = name.toLowerCase();
          
          if (lowerName.includes('docker') || lowerName.includes('br-') || lowerName.includes('veth')) {
            priority = 1;
          } else if (lowerName.includes('vmnet') || lowerName.includes('vboxnet')) {
            priority = 2;
          } else if (lowerName.includes('wlan') || lowerName.includes('wlp') || lowerName.includes('wifi')) {
            priority = 10;
          } else if (lowerName.includes('eth') || lowerName.includes('enp') || lowerName.includes('eno')) {
            priority = 9;
          } else {
            priority = 5;
          }

          candidates.push({ name, address: net.address, priority });
        }
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);
    this.log('Available interfaces:', candidates.map(c => `${c.name}(${c.priority}):${c.address}`).join(', '));

    if (candidates.length > 0) {
      const selected = candidates[0];
      this.log(`Selected interface: ${selected.name} (${selected.address})`);
      return selected.address;
    }

    return '127.0.0.1';
  }

  private getBroadcastAddress(): string {
    const parts = this.localIp.split('.');
    if (parts.length === 4) {
      parts[3] = '255';
      return parts.join('.');
    }
    return '255.255.255.255';
  }

  async start(): Promise<void> {
    this.log(`Starting discovery on ${this.localIp}:${this.port}`);

    this.socket = createSocket({ type: 'udp4', reuseAddr: true });
    
    this.socket.on('message', (msg, rinfo) => {
      const message = msg.toString();
      
      if (message.startsWith(DISCOVERY_MESSAGE)) {
        this.log(`Received discovery from ${rinfo.address}:${rinfo.port}`);
        
        const parts = message.split('|');
        if (parts.length >= 3) {
          const device: Device = {
            id: `${rinfo.address}:${parts[2]}`,
            name: parts[1],
            ip: rinfo.address,
            port: parseInt(parts[2], 10),
            lastSeen: new Date()
          };
          
          if (device.port !== this.port || rinfo.address !== this.localIp) {
            const existing = this.devices.get(device.id);
            if (!existing) {
              this.log(`New device found: ${device.name} (${device.ip}:${device.port})`);
              this.devices.set(device.id, device);
              this.emit('deviceFound', device);
            } else {
              existing.lastSeen = new Date();
            }
          }
          
          this.sendDiscoveryResponse(rinfo.address);
        }
      }
    });

    this.socket.on('error', (err) => {
      console.error('[Discovery] Socket error:', err.message);
    });

    return new Promise((resolve, reject) => {
      this.socket?.on('error', reject);
      
      // Try to bind to specific port, fallback to random port
      this.tryBind(DISCOVERY_PORT, (success) => {
        if (success) {
          this.boundPort = DISCOVERY_PORT;
          this.log(`Socket bound to port ${this.boundPort}`);
          this.socket?.setBroadcast(true);
          this.log('Broadcast mode enabled');
          this.startBroadcasting();
          resolve();
        } else {
          // Try random port
          this.socket?.bind(0, '0.0.0.0', () => {
            const address = this.socket?.address();
            this.boundPort = address?.port || DISCOVERY_PORT;
            this.log(`Socket bound to random port ${this.boundPort}`);
            this.socket?.setBroadcast(true);
            this.log('Broadcast mode enabled');
            this.startBroadcasting();
            resolve();
          });
        }
      });
    });
  }

  private tryBind(port: number, callback: (success: boolean) => void): void {
    this.socket?.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        this.log(`Port ${port} unavailable, will try random port`);
        callback(false);
      }
    });
    
    this.socket?.bind(port, '0.0.0.0', () => {
      callback(true);
    });
  }

  private startBroadcasting(): void {
    const broadcast = () => {
      const message = `${DISCOVERY_MESSAGE}|${this.deviceName}|${this.port}`;
      
      this.socket?.send(message, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) {
          this.log('Global broadcast error:', err.message);
        }
      });
      
      const subnetBroadcast = this.getBroadcastAddress();
      if (subnetBroadcast !== '255.255.255.255') {
        this.socket?.send(message, DISCOVERY_PORT, subnetBroadcast, (err) => {
          if (err) {
            this.log('Subnet broadcast error:', err.message);
          }
        });
      }
    };
    
    broadcast();
    this.broadcastInterval = setInterval(broadcast, DISCOVERY_INTERVAL);
  }

  private sendDiscoveryResponse(targetIp: string): void {
    const message = `${DISCOVERY_MESSAGE}|${this.deviceName}|${this.port}`;
    this.socket?.send(message, DISCOVERY_PORT, targetIp);
  }

  getLocalAddress(): string {
    return this.localIp;
  }

  getDevices(): Device[] {
    const now = new Date();
    for (const [id, device] of this.devices.entries()) {
      if (now.getTime() - device.lastSeen.getTime() > 30000) {
        this.devices.delete(id);
      }
    }
    return Array.from(this.devices.values());
  }

  stop(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
    }
    this.socket?.close();
  }
}
