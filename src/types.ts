export interface Device {
  id: string;
  name: string;
  ip: string;
  port: number;
  lastSeen: Date;
}

export interface FileTransfer {
  id: string;
  filename: string;
  size: number;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  fromDevice?: string;
  toDevice?: string;
  localPath?: string;
  remotePath?: string;
}

export interface TransferRequest {
  files: string[];
  targetDevice: Device;
}

export interface ServerConfig {
  port: number;
  deviceName: string;
  downloadDir: string;
}
