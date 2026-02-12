import express, { Request, Response, Express } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import mime from 'mime-types';
import { ServerConfig, FileTransfer } from './types';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

export class ShareServer {
  private app: Express;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private config: ServerConfig;
  private transfers: Map<string, FileTransfer> = new Map();
  private uploadsDir: string;

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
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  private setupRoutes(): void {
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, this.uploadsDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + '-' + file.originalname);
      }
    });
    
    const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB limit

    // Health check
    this.app.get('/api/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', device: this.config.deviceName });
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

    // Upload files
    this.app.post('/api/upload', upload.array('files', 50), (req: Request, res: Response) => {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const transfers: FileTransfer[] = files.map(file => ({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filename: file.originalname,
        size: file.size,
        progress: 100,
        status: 'completed',
        localPath: file.path
      }));

      transfers.forEach(t => this.transfers.set(t.id, t));
      this.broadcastTransferUpdate(transfers);

      res.json({ 
        message: 'Files uploaded successfully', 
        files: transfers.map(t => ({ id: t.id, filename: t.filename, size: t.size }))
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

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (message: string) => {
        try {
          const data = JSON.parse(message);
          if (data.type === 'getTransfers') {
            ws.send(JSON.stringify({
              type: 'transfers',
              data: Array.from(this.transfers.values())
            }));
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

  getTransfers(): FileTransfer[] {
    return Array.from(this.transfers.values());
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
