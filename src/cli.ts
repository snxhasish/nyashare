#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import ora from 'ora';
import axios from 'axios';
import inquirerFileTreeSelection from "inquirer-file-tree-selection-prompt"
import { ShareServer } from './server';
import { DeviceDiscovery } from './discovery';
import { FileTransferService } from './transfer';
import { Device, ServerConfig, IncomingTransferRequest } from './types';

const program = new Command();
inquirer.registerPrompt('file-tree-selection', inquirerFileTreeSelection)

function getDeviceName(): string {
  return os.hostname();
}

function getDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'nyashare');
}

function expandPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath === '~') {
    return os.homedir();
  }
  return inputPath;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getAllFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const stat = await fs.stat(dirPath);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllFiles(fullPath);
        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }
  } else {
    files.push(dirPath);
  }

  return files;
}

async function startServer(autoAccept = false): Promise<{ server: ShareServer; discovery: DeviceDiscovery; config: ServerConfig }> {
  const config: ServerConfig = {
    port: 3000,
    deviceName: getDeviceName(),
    downloadDir: getDownloadDir(),
    autoAccept
  };

  const net = await import('net');
  const findAvailablePort = (startPort: number): Promise<number> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(startPort, () => {
        const port = (server.address() as any).port;
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        findAvailablePort(startPort + 1).then(resolve);
      });
    });
  };

  config.port = await findAvailablePort(config.port);

  const server = new ShareServer(config);
  await server.start();

  const discovery = new DeviceDiscovery(config.deviceName, config.port);
  await discovery.start();

  return { server, discovery, config };
}

async function checkIncomingRequests(port: number): Promise<IncomingTransferRequest[]> {
  try {
    const response = await axios.get(`http://localhost:${port}/api/transfer/requests`, { timeout: 5000 });
    return response.data;
  } catch {
    return [];
  }
}

async function acceptRequest(port: number, requestId: string): Promise<boolean> {
  try {
    const response = await axios.post(`http://localhost:${port}/api/transfer/${requestId}/accept`, {}, { timeout: 5000 });
    return response.data.success;
  } catch {
    return false;
  }
}

async function declineRequest(port: number, requestId: string): Promise<boolean> {
  try {
    const response = await axios.post(`http://localhost:${port}/api/transfer/${requestId}/decline`, {}, { timeout: 5000 });
    return response.data.success;
  } catch {
    return false;
  }
}

program
  .name('nyashare')
  .description('CLI tool to quick share files over local network')
  .version('0.0.1');

program
  .command('start')
  .description('start the nyashare server and CLI')
  .option('-a, --auto-accept', 'automatically accept all incoming transfers', false)
  .action(async (options) => {

    const ear = chalk.blue.dim;
    const body = chalk.blue;

    console.log(`${ear("◤")}        ${ear("◥")}
${body("████████████")}   ${body("nyashare")}
${body("███   ██  ██")}   ${ear("v0.0.1")}
${body("████████████")}
${body("███        █")}
${body("……………………………………………………………………………")}
`);

    const spinner = ora(
      chalk.yellow('initializing server...')
    ).start();

    const { server, discovery, config } = await startServer(options.autoAccept);

    spinner.succeed(
      chalk.green('server started')
    );

    const localIp = discovery.getLocalAddress();
    const port = config.port;

    console.log(chalk.green('running'), chalk.blue('nyashare'), chalk.green(`on ${chalk.blue.underline(getDeviceName())}`));

    if (options.autoAccept) {
      console.log(chalk.yellow('⚡ auto-accept mode enabled - all transfers will be accepted automatically\n'));
    }

    console.log(chalk.gray(`share files through CLI or go to ${chalk.underline(`http://${localIp}:${port}/share\n`)}`));

    // Track processed requests to avoid duplicates
    const processedRequests = new Set<string>();
    let isPrompting = false;

    // Check for incoming requests periodically
    const requestInterval = setInterval(async () => {
      if (isPrompting) return;

      const requests = await checkIncomingRequests(port);
      const pendingRequests = requests.filter(r => !processedRequests.has(r.requestId));

      if (pendingRequests.length > 0) {
        isPrompting = true;
        
        for (const request of pendingRequests) {
          console.log(chalk.cyan(`\n\n📨 incoming transfer request from ${chalk.bold(request.fromDevice)}`));
          console.log(chalk.gray(`   files: ${request.files.length} file(s)`));
          console.log(chalk.gray(`   total size: ${formatFileSize(request.totalSize)}`));
          
          if (request.files.length <= 5) {
            request.files.forEach(f => {
              console.log(chalk.gray(`   - ${f.filename} (${formatFileSize(f.size)})`));
            });
          } else {
            request.files.slice(0, 3).forEach(f => {
              console.log(chalk.gray(`   - ${f.filename} (${formatFileSize(f.size)})`));
            });
            console.log(chalk.gray(`   ... and ${request.files.length - 3} more file(s)`));
          }
          console.log();

          const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: `accept transfer from ${request.fromDevice}?`,
            choices: [
              { name: '✅ accept', value: 'accept' },
              { name: '❌ decline', value: 'decline' },
              { name: '⏱️  wait (decide later)', value: 'wait' }
            ]
          }]);

          if (action === 'accept') {
            const acceptSpinner = ora('accepting transfer...').start();
            const success = await acceptRequest(port, request.requestId);
            if (success) {
              acceptSpinner.succeed('transfer accepted - files will be downloaded automatically');
            } else {
              acceptSpinner.fail('failed to accept transfer');
            }
            processedRequests.add(request.requestId);
          } else if (action === 'decline') {
            const declineSpinner = ora('declining transfer...').start();
            const success = await declineRequest(port, request.requestId);
            if (success) {
              declineSpinner.succeed('transfer declined');
            } else {
              declineSpinner.fail('failed to decline transfer');
            }
            processedRequests.add(request.requestId);
          }
          // If 'wait' is selected, don't add to processedRequests so it will be prompted again
        }

        isPrompting = false;
        console.log();
      }
    }, 3000);

    const showPrompt = async () => {
      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'select an action',
        choices: [
          { name: '📤 send files/folders', value: 'send' },
          { name: '👥 list active devices on network', value: 'devices' },
          { name: '🌐 open web UI for sharing', value: 'web' },
          { name: '❌ exit', value: 'exit' }
        ]
      }]);

      if (action === 'exit') {
        clearInterval(requestInterval);
        console.log(chalk.yellow('\nclosing'), chalk.blue('nyashare'));
        discovery.stop();
        server.stop();
        process.exit(0);
      } else if (action === 'web') {
        const open = await import('open');
        await open.default(`http://${localIp}:${port}/share`);
        console.log(chalk.blue(`\n🌐 opening http://${localIp}:${port}/share in your browser.\n`));
        showPrompt();
      } else if (action === 'devices') {
        const devices = discovery.getDevices();
        if (devices.length === 0) {
          console.log(chalk.yellow('\n⚠️  no devices found on the network.\n'));
        } else {
          console.log(chalk.blue('\n📱 available devices:'));
          devices.forEach((device, i) => {
            console.log(`   ${i + 1}. ${chalk.bold(device.name)} (${device.ip}:${device.port})`);
          });
          console.log('');
        }
        showPrompt();
      } else if (action === 'send') {
        const { filePath } = await inquirer.prompt([{
          type: 'file-tree-selection',
          name: 'filePath',
          message: 'enter file or folder path to send:',
          enableGoUpperDirectory: true,
          validate: async (input: string) => {
            if (input.length > 0) {
              return true
            } else {
              return "path cannot be empty"
            }
            const expanded = expandPath(input);
            const resolved = path.resolve(expanded);
            try {
              await fs.access(resolved);
              return true;
            } catch {
              return 'path does not exist. please enter a valid path.';
            }
          }
        }]);

        const expandedPath = expandPath(filePath);
        const resolvedPath = path.resolve(expandedPath);
        const files = await getAllFiles(resolvedPath);

        if (files.length === 0) {
          console.log(chalk.yellow('\n⚠️  no files found to send.\n'));
          showPrompt();
          return;
        }

        console.log(chalk.cyan(`\n📁 found ${files.length} file(s) to send\n`));

        // Wait a moment for discovery to find devices
        await new Promise(resolve => setTimeout(resolve, 2000));

        let devices = discovery.getDevices();
        let targetDevice: Device | null = null;

        if (devices.length === 0) {
          console.log(chalk.yellow('⚠️  no devices found on the network.\n'));

          const { manualEntry } = await inquirer.prompt([{
            type: 'confirm',
            name: 'manualEntry',
            message: 'would you like to manually enter device IP? (useful for android/termux)',
            default: true
          }]);

          if (manualEntry) {
            const { ip, port } = await inquirer.prompt([{
              type: 'input',
              name: 'ip',
              message: 'enter device IP address:',
              validate: (input: string) => {
                if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) return true;
                return 'please enter a valid IP address (e.g., 192.168.2.100)';
              }
            }, {
              type: 'input',
              name: 'port',
              message: 'enter device port (usually 3000):',
              default: '3000',
              validate: (input: string) => {
                const port = parseInt(input);
                if (port > 0 && port < 65536) return true;
                return 'please enter a valid port number';
              }
            }]);

            targetDevice = {
              id: `${ip}:${port}`,
              name: 'manual device',
              ip: ip,
              port: parseInt(port),
              lastSeen: new Date()
            };
          } else {
            console.log(chalk.yellow('waiting 5 seconds for discovery...\n'));
            await new Promise(resolve => setTimeout(resolve, 5000));
            devices = discovery.getDevices();

            if (devices.length === 0) {
              console.log(chalk.red('❌ still no devices found. make sure other devices are running nyashare.\n'));
              showPrompt();
              return;
            }
          }
        }

        if (!targetDevice) {
          const currentDevices = discovery.getDevices();
          const choices = currentDevices.map((device, _index) => ({
            name: `${device.name} (${device.ip})`,
            value: device
          }));

          const result = await inquirer.prompt([{
            type: 'list',
            name: 'targetDevice',
            message: 'choose a device to send files to:',
            choices
          }]);
          targetDevice = result.targetDevice;
        }

        if (!targetDevice) {
          console.log(chalk.red('❌ no device selected.\n'));
          showPrompt();
          return;
        }

        console.log(chalk.cyan(`\n📤 sending ${files.length} file(s) to ${chalk.bold(targetDevice.name)} (${targetDevice.ip})...\n`));

        const transferService = new FileTransferService();
        let completed = 0;
        let isWaiting = false;

        try {
          await transferService.sendFiles(files, targetDevice, (transfer) => {
            if (transfer.status === 'pending' && !isWaiting) {
              console.log(chalk.yellow(`⏳ waiting for ${targetDevice.name} to accept the transfer...`));
              isWaiting = true;
            } else if (transfer.status === 'transferring') {
              if (isWaiting) {
                console.log(chalk.green(`✅ transfer accepted! uploading files...\n`));
                isWaiting = false;
              }
            } else if (transfer.status === 'completed') {
              completed++;
              process.stdout.write(`\r${chalk.green('⏵')} Progress: ${completed}/${files.length} files completed`);
            }
          }, getDeviceName());

          console.log(chalk.green(`\n\n✅ successfully sent ${files.length} file(s) to ${targetDevice.name}!\n`));
        } catch (error: any) {
          if (error.message?.includes('declined')) {
            console.error(chalk.red(`\n\n❌ transfer was declined by ${targetDevice.name}\n`));
          } else if (error.message?.includes('expired')) {
            console.error(chalk.red(`\n\n❌ transfer request expired\n`));
          } else if (error.message?.includes('timed out')) {
            console.error(chalk.red(`\n\n❌ transfer timed out waiting for approval\n`));
          } else {
            console.error(chalk.red(`\n\n❌ failed to send files: ${error}\n`));
          }
        }

        showPrompt();
      }
    };

    showPrompt();
  });

program
  .command('receive')
  .description('start in receiver mode - only accept/decline incoming transfers')
  .option('-a, --auto-accept', 'automatically accept all incoming transfers', false)
  .action(async (options) => {
    const ear = chalk.blue.dim;
    const body = chalk.blue;

    console.log(`${ear("◤")}        ${ear("◥")}
${body("████████████")}   ${body("nyashare - receiver mode")}
${body("███   ██  ██")}   ${ear("v0.0.1")}
${body("████████████")}
${body("███        █")}
${body("……………………………………………………………………………")}
`);

    const spinner = ora(
      chalk.yellow('initializing receiver...')
    ).start();

    const { server, discovery, config } = await startServer(options.autoAccept);

    spinner.succeed(
      chalk.green('receiver ready')
    );

    const localIp = discovery.getLocalAddress();
    const port = config.port;

    console.log(chalk.green('receiver mode'), chalk.blue('nyashare'), chalk.green(`on ${chalk.blue.underline(getDeviceName())}`));
    
    if (options.autoAccept) {
      console.log(chalk.yellow('⚡ auto-accept mode enabled\n'));
    } else {
      console.log(chalk.cyan('waiting for incoming transfer requests...\n'));
    }

    console.log(chalk.gray(`web interface: ${chalk.underline(`http://${localIp}:${port}/share\n`)}`));

    // In receiver mode, we just wait for requests
    const processedRequests = new Set<string>();

    const checkRequests = async () => {
      const requests = await checkIncomingRequests(port);
      const pendingRequests = requests.filter(r => !processedRequests.has(r.requestId));

      for (const request of pendingRequests) {
        if (options.autoAccept) {
          console.log(chalk.green(`\n✅ auto-accepted transfer from ${chalk.bold(request.fromDevice)}`));
          console.log(chalk.gray(`   files: ${request.files.length} file(s), total: ${formatFileSize(request.totalSize)}`));
          await acceptRequest(port, request.requestId);
          processedRequests.add(request.requestId);
        } else {
          console.log(chalk.cyan(`\n📨 incoming transfer from ${chalk.bold(request.fromDevice)}`));
          console.log(chalk.gray(`   files: ${request.files.length} file(s)`));
          console.log(chalk.gray(`   total size: ${formatFileSize(request.totalSize)}`));
          
          if (request.files.length <= 5) {
            request.files.forEach(f => {
              console.log(chalk.gray(`   - ${f.filename} (${formatFileSize(f.size)})`));
            });
          } else {
            request.files.slice(0, 3).forEach(f => {
              console.log(chalk.gray(`   - ${f.filename} (${formatFileSize(f.size)})`));
            });
            console.log(chalk.gray(`   ... and ${request.files.length - 3} more file(s)`));
          }
          console.log();

          const { action } = await inquirer.prompt([{
            type: 'list',
            name: 'action',
            message: `accept transfer from ${request.fromDevice}?`,
            choices: [
              { name: '✅ accept', value: 'accept' },
              { name: '❌ decline', value: 'decline' }
            ]
          }]);

          if (action === 'accept') {
            const acceptSpinner = ora('accepting transfer...').start();
            const success = await acceptRequest(port, request.requestId);
            if (success) {
              acceptSpinner.succeed('transfer accepted');
            } else {
              acceptSpinner.fail('failed to accept transfer');
            }
            processedRequests.add(request.requestId);
          } else {
            const declineSpinner = ora('declining transfer...').start();
            const success = await declineRequest(port, request.requestId);
            if (success) {
              declineSpinner.succeed('transfer declined');
            } else {
              declineSpinner.fail('failed to decline transfer');
            }
            processedRequests.add(request.requestId);
          }
          console.log();
        }
      }
    };

    // Check for requests every 2 seconds
    const interval = setInterval(checkRequests, 2000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log(chalk.yellow('\nclosing'), chalk.blue('nyashare'));
      discovery.stop();
      server.stop();
      process.exit(0);
    });

    // Keep the process running
    await new Promise(() => {});
  });

if (process.argv.length === 2) {
  program.parse(['node', 'cli', 'start']);
} else {
  program.parse();
}
