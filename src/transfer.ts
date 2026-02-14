import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs-extra';
import path from 'path';
import { Device, FileTransfer, TransferRequestData } from './types';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export class FileTransferService {
  private transfers: Map<string, FileTransfer> = new Map();

  async sendFiles(
    files: string[], 
    device: Device, 
    onProgress?: (transfer: FileTransfer) => void,
    deviceName?: string
  ): Promise<FileTransfer[]> {
    const transfers: FileTransfer[] = [];
    
    // First, collect all file info
    const fileInfos = [];
    let totalSize = 0;
    
    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      fileInfos.push({
        path: filePath,
        filename: path.basename(filePath),
        size: stat.size
      });
      totalSize += stat.size;
    }

    // Create transfer request data
    const requestData: TransferRequestData = {
      requestId: '', // Will be filled by server
      fromDevice: deviceName || 'Unknown Device',
      fromIp: '',
      files: fileInfos.map(f => ({ filename: f.filename, size: f.size })),
      totalSize
    };

    // Step 1: Request permission to transfer
    let requestId: string;
    let autoAccept = false;
    
    try {
      const requestResponse = await axios.post(
        `http://${device.ip}:${device.port}/api/transfer/request`,
        requestData,
        { timeout: 10000 }
      );
      
      requestId = requestResponse.data.requestId;
      autoAccept = requestResponse.data.autoAccept;
      
      if (!autoAccept) {
        onProgress?.({
          id: requestId,
          filename: `Waiting for approval from ${device.name}...`,
          size: totalSize,
          progress: 0,
          status: 'pending',
          toDevice: device.name
        } as FileTransfer);
      }
    } catch (error) {
      throw new Error(`Failed to request transfer: ${error}`);
    }

    // Step 2: Poll for approval status
    if (!autoAccept) {
      let approved = false;
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes (5 second intervals)
      
      while (!approved && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        try {
          const statusResponse = await axios.get(
            `http://${device.ip}:${device.port}/api/transfer/${requestId}/status`,
            { timeout: 5000 }
          );
          
          const status = statusResponse.data.status;
          
          if (status === 'accepted') {
            approved = true;
          } else if (status === 'declined') {
            throw new Error('Transfer was declined by the receiver');
          } else if (status === 'expired') {
            throw new Error('Transfer request expired');
          }
        } catch (error: any) {
          if (error.message?.includes('declined') || error.message?.includes('expired')) {
            throw error;
          }
          // Continue polling on network errors
        }
        
        attempts++;
      }
      
      if (!approved) {
        throw new Error('Transfer request timed out waiting for approval');
      }
    }

    // Step 3: Upload files with the approved request ID
    for (const fileInfo of fileInfos) {
      const transfer: FileTransfer = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filename: fileInfo.filename,
        size: fileInfo.size,
        progress: 0,
        status: 'transferring',
        toDevice: device.name
      };
      
      this.transfers.set(transfer.id, transfer);
      transfers.push(transfer);

      try {
        const form = new FormData();
        form.append('files', fs.createReadStream(fileInfo.path), {
          filename: fileInfo.filename,
          knownLength: fileInfo.size
        });

        await axios.post(
          `http://${device.ip}:${device.port}/api/upload`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'X-Transfer-Request-ID': requestId
            },
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
