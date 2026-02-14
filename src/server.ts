import express, { Request, Response, Express } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import mime from 'mime-types';
import { ServerConfig, FileTransfer, IncomingTransferRequest, TransferRequestData } from './types';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

export class ShareServer {
  private app: Express;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private config: ServerConfig;
  private transfers: Map<string, FileTransfer> = new Map();
  private incomingRequests: Map<string, IncomingTransferRequest> = new Map();
  private uploadsDir: string;
  private pendingUploads: Map<string, Express.Multer.File[]> = new Map();

  constructor(config: ServerConfig) {
    this.config = config;
    this.uploadsDir = path.join(config.downloadDir, 'uploads');
    fs.ensureDirSync(this.uploadsDir);
    
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.startRequestCleanup();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  private setupRoutes(): void {
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        const requestId = req.headers['x-transfer-request-id'] as string;
        if (requestId) {
          // Store in temp directory until approved
          const tempDir = path.join(this.uploadsDir, '.temp', requestId);
          fs.ensureDirSync(tempDir);
          cb(null, tempDir);
        } else {
          cb(null, this.uploadsDir);
        }
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + '-' + file.originalname);
      }
    });
    
    const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB limit

    // Health check
    this.app.get('/api/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', device: this.config.deviceName, autoAccept: this.config.autoAccept ?? false });
    });

    // Request transfer - sender asks permission before uploading
    this.app.post('/api/transfer/request', (req: Request, res: Response) => {
      const { fromDevice, files, totalSize } = req.body as TransferRequestData;
      const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const request: IncomingTransferRequest = {
        id: requestId,
        requestId,
        fromDevice: fromDevice || 'Unknown Device',
        fromIp: req.ip || req.socket.remoteAddress || 'unknown',
        files: files || [],
        totalSize: totalSize || 0,
        status: 'pending',
        createdAt: new Date()
      };

      this.incomingRequests.set(requestId, request);
      
      // Notify all connected clients about the new request
      this.broadcastRequestUpdate(request);
      
      res.json({ 
        requestId, 
        status: 'pending',
        autoAccept: this.config.autoAccept ?? false,
        message: this.config.autoAccept ? 'Transfer auto-accepted' : 'Waiting for approval'
      });

      // If auto-accept is enabled, automatically approve
      if (this.config.autoAccept) {
        setTimeout(() => {
          this.acceptTransferRequest(requestId);
        }, 100);
      }
    });

    // Get pending transfer requests
    this.app.get('/api/transfer/requests', (req: Request, res: Response) => {
      const requests = Array.from(this.incomingRequests.values())
        .filter(r => r.status === 'pending')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      res.json(requests);
    });

    // Accept transfer request
    this.app.post('/api/transfer/:requestId/accept', (req: Request, res: Response) => {
      const { requestId } = req.params;
      const success = this.acceptTransferRequest(requestId);
      
      if (success) {
        res.json({ success: true, message: 'Transfer accepted' });
      } else {
        res.status(404).json({ success: false, error: 'Request not found or already processed' });
      }
    });

    // Decline transfer request
    this.app.post('/api/transfer/:requestId/decline', (req: Request, res: Response) => {
      const { requestId } = req.params;
      const request = this.incomingRequests.get(requestId);
      
      if (!request) {
        return res.status(404).json({ success: false, error: 'Request not found' });
      }

      request.status = 'declined';
      this.incomingRequests.set(requestId, request);
      
      // Clean up any temp files
      const tempDir = path.join(this.uploadsDir, '.temp', requestId);
      fs.removeSync(tempDir);
      this.pendingUploads.delete(requestId);
      
      this.broadcastRequestUpdate(request);
      
      res.json({ success: true, message: 'Transfer declined' });
    });

    // Check transfer request status
    this.app.get('/api/transfer/:requestId/status', (req: Request, res: Response) => {
      const { requestId } = req.params;
      const request = this.incomingRequests.get(requestId);
      
      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }
      
      res.json({ 
        requestId, 
        status: request.status,
        canUpload: request.status === 'accepted'
      });
    });

    // Get available files
    this.app.get('/api/files', async (req: Request, res: Response) => {
      try {
        const files = await fs.readdir(this.uploadsDir);
        const fileInfos = await Promise.all(
          files.map(async (filename) => {
            const filepath = path.join(this.uploadsDir, filename);
            const stat = await fs.stat(filepath);
            return {
              name: filename.replace(/^\d+-\d+-/, ''),
              originalName: filename,
              size: stat.size,
              modified: stat.mtime,
              mimeType: mime.lookup(filename) || 'application/octet-stream'
            };
          })
        );
        res.json(fileInfos);
      } catch (error) {
        res.status(500).json({ error: 'Failed to list files' });
      }
    });

    // Upload files - now requires approval
    this.app.post('/api/upload', (req: Request, res: Response) => {
      const requestId = req.headers['x-transfer-request-id'] as string;
      
      if (!requestId) {
        return res.status(400).json({ error: 'Missing transfer request ID' });
      }

      const request = this.incomingRequests.get(requestId);
      
      if (!request) {
        return res.status(404).json({ error: 'Transfer request not found' });
      }

      if (request.status !== 'accepted') {
        return res.status(403).json({ 
          error: 'Transfer not approved', 
          status: request.status 
        });
      }

      // Process the upload
      upload.array('files', 50)(req, res, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Upload failed: ' + err.message });
        }

        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
          return res.status(400).json({ error: 'No files uploaded' });
        }

        // Move files from temp to final location
        const transfers: FileTransfer[] = files.map(file => {
          const finalPath = path.join(this.uploadsDir, path.basename(file.path));
          fs.moveSync(file.path, finalPath, { overwrite: true });
          
          return {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            filename: file.originalname,
            size: file.size,
            progress: 100,
            status: 'completed',
            localPath: finalPath,
            fromDevice: request.fromDevice
          };
        });

        // Clean up temp directory
        const tempDir = path.join(this.uploadsDir, '.temp', requestId);
        fs.removeSync(tempDir);

        transfers.forEach(t => this.transfers.set(t.id, t));
        this.broadcastTransferUpdate(transfers);

        res.json({ 
          message: 'Files uploaded successfully', 
          files: transfers.map(t => ({ id: t.id, filename: t.filename, size: t.size }))
        });
      });
    });

    // Download file
    this.app.get('/api/download/:filename', async (req: Request, res: Response) => {
      const filename = req.params.filename;
      const filepath = path.join(this.uploadsDir, filename);
      
      try {
        await fs.access(filepath);
        const mimeType = mime.lookup(filename) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/^\d+-\d+-/, '')}"`);
        res.sendFile(filepath);
      } catch {
        res.status(404).json({ error: 'File not found' });
      }
    });

    // Delete file
    this.app.delete('/api/files/:filename', async (req: Request, res: Response) => {
      const filename = req.params.filename;
      const filepath = path.join(this.uploadsDir, filename);
      
      try {
        await fs.remove(filepath);
        res.json({ message: 'File deleted' });
      } catch {
        res.status(500).json({ error: 'Failed to delete file' });
      }
    });

    // Share route
    this.app.get('/share', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../public/share.html'));
    });

    // Root route
    this.app.get('/', (req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });
  }

  private acceptTransferRequest(requestId: string): boolean {
    const request = this.incomingRequests.get(requestId);
    
    if (!request || request.status !== 'pending') {
      return false;
    }

    request.status = 'accepted';
    this.incomingRequests.set(requestId, request);
    this.broadcastRequestUpdate(request);
    
    return true;
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      // Send current requests and transfers to new connection
      const pendingRequests = Array.from(this.incomingRequests.values())
        .filter(r => r.status === 'pending');
      
      ws.send(JSON.stringify({
        type: 'requests',
        data: pendingRequests
      }));

      ws.send(JSON.stringify({
        type: 'transfers',
        data: Array.from(this.transfers.values())
      }));

      ws.on('message', (message: string) => {
        try {
          const data = JSON.parse(message);
          if (data.type === 'getTransfers') {
            ws.send(JSON.stringify({
              type: 'transfers',
              data: Array.from(this.transfers.values())
            }));
          } else if (data.type === 'getRequests') {
            const requests = Array.from(this.incomingRequests.values())
              .filter(r => r.status === 'pending');
            ws.send(JSON.stringify({
              type: 'requests',
              data: requests
            }));
          } else if (data.type === 'acceptRequest') {
            this.acceptTransferRequest(data.requestId);
          } else if (data.type === 'declineRequest') {
            const request = this.incomingRequests.get(data.requestId);
            if (request) {
              request.status = 'declined';
              this.incomingRequests.set(data.requestId, request);
              this.broadcastRequestUpdate(request);
            }
          }
        } catch {
          // Ignore invalid messages
        }
      });
    });
  }

  private broadcastTransferUpdate(_transfers: FileTransfer[]): void {
    const message = JSON.stringify({
      type: 'transfers',
      data: Array.from(this.transfers.values())
    });
    
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  private broadcastRequestUpdate(request: IncomingTransferRequest): void {
    const message = JSON.stringify({
      type: 'requestUpdate',
      data: request
    });
    
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  private startRequestCleanup(): void {
    // Clean up expired requests every minute
    setInterval(() => {
      const now = new Date().getTime();
      const expiryTime = 5 * 60 * 1000; // 5 minutes
      
      for (const [id, request] of this.incomingRequests.entries()) {
        if (request.status === 'pending' && (now - request.createdAt.getTime()) > expiryTime) {
          request.status = 'expired';
          this.incomingRequests.set(id, request);
          this.broadcastRequestUpdate(request);
          
          // Clean up temp files
          const tempDir = path.join(this.uploadsDir, '.temp', id);
          fs.removeSync(tempDir);
        }
      }
    }, 60000);
  }

  getTransfers(): FileTransfer[] {
    return Array.from(this.transfers.values());
  }

  getIncomingRequests(): IncomingTransferRequest[] {
    return Array.from(this.incomingRequests.values());
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, () => {
        resolve();
      });
    });
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }
}
