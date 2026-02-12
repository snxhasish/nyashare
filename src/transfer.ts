import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs-extra';
import path from 'path';
import { Device, FileTransfer } from './types';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export class FileTransferService {
  private transfers: Map<string, FileTransfer> = new Map();

  async sendFiles(
    files: string[], 
    device: Device, 
    onProgress?: (transfer: FileTransfer) => void
  ): Promise<FileTransfer[]> {
    const transfers: FileTransfer[] = [];
    
    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      const transfer: FileTransfer = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filename: path.basename(filePath),
        size: stat.size,
        progress: 0,
        status: 'pending',
        toDevice: device.name
      };
      
      this.transfers.set(transfer.id, transfer);
      transfers.push(transfer);

      try {
        transfer.status = 'transferring';
        
        const form = new FormData();
        form.append('files', fs.createReadStream(filePath), {
          filename: path.basename(filePath),
          knownLength: stat.size
        });

        await axios.post(
          `http://${device.ip}:${device.port}/api/upload`,
          form,
          {
            headers: form.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            onUploadProgress: (progressEvent) => {
              if (progressEvent.total) {
                transfer.progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                onProgress?.(transfer);
              }
            }
          }
        );

        transfer.status = 'completed';
        transfer.progress = 100;
        onProgress?.(transfer);
      } catch (error) {
        transfer.status = 'failed';
        onProgress?.(transfer);
        throw error;
      }
    }

    return transfers;
  }

  async downloadFile(
    filename: string, 
    device: Device, 
    downloadDir: string,
    onProgress?: (progress: number) => void
  ): Promise<string> {
    const outputPath = path.join(downloadDir, filename.replace(/^\d+-\d+-/, ''));
    await fs.ensureDir(path.dirname(outputPath));

    const response = await axios({
      method: 'GET',
      url: `http://${device.ip}:${device.port}/api/download/${filename}`,
      responseType: 'stream'
    });

    const totalLength = parseInt(response.headers['content-length'] || '0', 10);
    let downloadedLength = 0;

    const writeStream = createWriteStream(outputPath);
    
    response.data.on('data', (chunk: Buffer) => {
      downloadedLength += chunk.length;
      if (totalLength > 0) {
        onProgress?.(Math.round((downloadedLength * 100) / totalLength));
      }
    });

    await pipeline(response.data, writeStream);
    
    return outputPath;
  }

  getTransfers(): FileTransfer[] {
    return Array.from(this.transfers.values());
  }
}
