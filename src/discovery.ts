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
          // Priority: WiFi/Ethernet > others > Docker/VM interfaces
          let priority = 0;
          const lowerName = name.toLowerCase();
          
          if (lowerName.includes('docker') || lowerName.includes('br-') || lowerName.includes('veth')) {
            priority = 1; // Docker interfaces - lowest priority
          } else if (lowerName.includes('vmnet') || lowerName.includes('vboxnet')) {
            priority = 2; // VM interfaces
          } else if (lowerName.includes('wlan') || lowerName.includes('wlp') || lowerName.includes('wifi')) {
            priority = 10; // WiFi - high priority
          } else if (lowerName.includes('eth') || lowerName.includes('enp') || lowerName.includes('eno')) {
            priority = 9; // Ethernet - high priority
          } else {
            priority = 5; // Other interfaces
          }

          candidates.push({ name, address: net.address, priority });
        }
      }
    }

    // Sort by priority (highest first)
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
    // Calculate subnet broadcast address (e.g., 10.146.30.118 -> 10.146.30.255)
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
          
          // Ignore self
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
          
          // Send response
          this.sendDiscoveryResponse(rinfo.address);
        }
      }
    });

    this.socket.on('error', (err) => {
      console.error('[Discovery] Socket error:', err.message);
    });

    this.socket.bind(DISCOVERY_PORT, () => {
      this.log(`Socket bound to port ${DISCOVERY_PORT}`);
      this.socket?.setBroadcast(true);
      this.log('Broadcast mode enabled');
      this.startBroadcasting();
    });
  }

  private startBroadcasting(): void {
    const broadcast = () => {
      const message = `${DISCOVERY_MESSAGE}|${this.deviceName}|${this.port}`;
      
      // Send to global broadcast
      this.socket?.send(message, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) {
          this.log('Global broadcast error:', err.message);
        }
      });
      
      // Also send to subnet-specific broadcast
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
    // Clean up old devices (not seen in 30 seconds)
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
