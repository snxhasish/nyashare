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

export interface TransferRequestPayload {
  files: string[];
  targetDevice: Device;
}

export interface IncomingTransferRequest {
  id: string;
  requestId: string;
  fromDevice: string;
  fromIp: string;
  files: Array<{
    filename: string;
    size: number;
  }>;
  totalSize: number;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  createdAt: Date;
}

export interface TransferRequestData {
  requestId: string;
  fromDevice: string;
  fromIp: string;
  files: Array<{
    filename: string;
    size: number;
  }>;
  totalSize: number;
}

export interface ServerConfig {
  port: number;
  deviceName: string;
  downloadDir: string;
  autoAccept?: boolean;
}
