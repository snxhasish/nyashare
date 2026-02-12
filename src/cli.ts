#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import ora from 'ora';
import { ShareServer } from './server';
import { DeviceDiscovery } from './discovery';
import { FileTransferService } from './transfer';
import { Device, ServerConfig } from './types';

const program = new Command();

function getDeviceName(): string {
  return os.hostname();
}

function getDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads', 'nyashare');
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

async function startServer(): Promise<{ server: ShareServer; discovery: DeviceDiscovery }> {
  const config: ServerConfig = {
    port: 3000,
    deviceName: getDeviceName(),
    downloadDir: getDownloadDir()
  };

  // Find available port
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

  return { server, discovery };
}

program
  .name('nyashare')
  .description('CLI tool to share files over local network')
  .version('1.0.0');

program
  .command('start')
  .description('Start the nyashare server and CLI')
  .action(async () => {
    console.log(chalk.cyan.bold('\n🚀 Starting nyashare...\n'));
    
    const spinner = ora('Initializing server...').start();
    const { server, discovery } = await startServer();
    spinner.succeed('Server started!');

    const localIp = discovery.getLocalAddress();
    const port = 3000;

    console.log(chalk.green(`\n✅ Running nyashare on ${chalk.bold(getDeviceName())}`));
    console.log(chalk.gray(`   Share files through CLI or go to http://${localIp}:${port}/share\n`));

    const showPrompt = async () => {
      const { action } = await inquirer.prompt([{
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: '📤 Send files/folders', value: 'send' },
          { name: '👥 List devices', value: 'devices' },
          { name: '🌐 Open web UI', value: 'web' },
          { name: '❌ Exit', value: 'exit' }
        ]
      }]);

      if (action === 'exit') {
        console.log(chalk.yellow('\n👋 Shutting down...'));
        discovery.stop();
        server.stop();
        process.exit(0);
      } else if (action === 'web') {
        const open = await import('open');
        await open.default(`http://${localIp}:${port}/share`);
        console.log(chalk.blue(`\n🌐 Opening http://${localIp}:${port}/share\n`));
        showPrompt();
      } else if (action === 'devices') {
        const devices = discovery.getDevices();
        if (devices.length === 0) {
          console.log(chalk.yellow('\n⚠️  No devices found on the network.\n'));
        } else {
          console.log(chalk.cyan('\n📱 Available devices:'));
          devices.forEach((device, i) => {
            console.log(`   ${i + 1}. ${chalk.bold(device.name)} (${device.ip}:${device.port})`);
          });
          console.log('');
        }
        showPrompt();
      } else if (action === 'send') {
        const { filePath } = await inquirer.prompt([{
          type: 'input',
          name: 'filePath',
          message: 'Enter file or folder path to send:',
          validate: async (input: string) => {
            const resolved = path.resolve(input);
            try {
              await fs.access(resolved);
              return true;
            } catch {
              return 'Path does not exist. Please enter a valid path.';
            }
          }
        }]);

        const resolvedPath = path.resolve(filePath);
        const files = await getAllFiles(resolvedPath);
        
        if (files.length === 0) {
          console.log(chalk.yellow('\n⚠️  No files found to send.\n'));
          showPrompt();
          return;
        }

        console.log(chalk.cyan(`\n📁 Found ${files.length} file(s) to send\n`));

        // Wait a moment for discovery to find devices
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        let devices = discovery.getDevices();
        let targetDevice: Device | null = null;
        
        if (devices.length === 0) {
          console.log(chalk.yellow('⚠️  No devices found on the network.\n'));
          
          const { manualEntry } = await inquirer.prompt([{
            type: 'confirm',
            name: 'manualEntry',
            message: 'Would you like to manually enter device IP? (useful for Android/Termux)',
            default: true
          }]);
          
          if (manualEntry) {
            const { ip, port } = await inquirer.prompt([{
              type: 'input',
              name: 'ip',
              message: 'Enter device IP address:',
              validate: (input: string) => {
                if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) return true;
                return 'Please enter a valid IP address (e.g., 192.168.2.100)';
              }
            }, {
              type: 'input',
              name: 'port',
              message: 'Enter device port (usually 3000):',
              default: '3000',
              validate: (input: string) => {
                const port = parseInt(input);
                if (port > 0 && port < 65536) return true;
                return 'Please enter a valid port number';
              }
            }]);
            
            targetDevice = {
              id: `${ip}:${port}`,
              name: 'Manual Device',
              ip: ip,
              port: parseInt(port),
              lastSeen: new Date()
            };
          } else {
            console.log(chalk.yellow('Waiting 5 seconds for discovery...\n'));
            await new Promise(resolve => setTimeout(resolve, 5000));
            devices = discovery.getDevices();
            
            if (devices.length === 0) {
              console.log(chalk.red('❌ Still no devices found. Make sure other devices are running nyashare.\n'));
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
            message: 'Choose a device to send files to:',
            choices
          }]);
          targetDevice = result.targetDevice;
        }

        if (!targetDevice) {
          console.log(chalk.red('❌ No device selected.\n'));
          showPrompt();
          return;
        }

        console.log(chalk.cyan(`\n📤 Sending ${files.length} file(s) to ${chalk.bold(targetDevice.name)} (${targetDevice.ip})...\n`));

        const transferService = new FileTransferService();
        let completed = 0;
        
        try {
          await transferService.sendFiles(files, targetDevice, (transfer) => {
            if (transfer.status === 'completed') {
              completed++;
              process.stdout.write(`\r${chalk.green('⏵')} Progress: ${completed}/${files.length} files completed`);
            }
          });
          
          console.log(chalk.green(`\n\n✅ Successfully sent ${files.length} file(s) to ${targetDevice.name}!\n`));
        } catch (error) {
          console.error(chalk.red(`\n\n❌ Failed to send files: ${error}\n`));
        }

        showPrompt();
      }
    };

    showPrompt();
  });

program
  .command('send <path>')
  .description('Send a file or folder to a device')
  .action(async (filePath: string) => {
    const resolvedPath = path.resolve(filePath);
    
    try {
      await fs.access(resolvedPath);
    } catch {
      console.error(chalk.red(`❌ Path does not exist: ${filePath}`));
      process.exit(1);
    }

    const spinner = ora('Starting server...').start();
    const { server, discovery } = await startServer();
    spinner.succeed('Server started');

    const files = await getAllFiles(resolvedPath);
    console.log(chalk.cyan(`📁 Found ${files.length} file(s) to send`));

    // Wait for devices
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const devices = discovery.getDevices();
    
    if (devices.length === 0) {
      console.log(chalk.yellow('\n⚠️  No devices found. Waiting 10 seconds...'));
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      const updatedDevices = discovery.getDevices();
      if (updatedDevices.length === 0) {
        console.error(chalk.red('\n❌ No devices found. Make sure other devices are running nyashare.'));
        discovery.stop();
        server.stop();
        process.exit(1);
      }
    }

    const currentDevices = discovery.getDevices();
    const choices = currentDevices.map(device => ({
      name: `${device.name} (${device.ip})`,
      value: device
    }));

    const { targetDevice } = await inquirer.prompt([{
      type: 'list',
      name: 'targetDevice',
      message: 'Choose a device to send to:',
      choices
    }]);

    console.log(chalk.cyan(`\n📤 Sending to ${targetDevice.name}...`));
    
    const transferService = new FileTransferService();
    const transfers = await transferService.sendFiles(files, targetDevice, (transfer) => {
      if (transfer.progress % 10 === 0) {
        process.stdout.write(`\r${transfer.filename}: ${transfer.progress}%`);
      }
    });

    console.log(chalk.green(`\n✅ Sent ${transfers.length} file(s) successfully!`));
    
    discovery.stop();
    server.stop();
    process.exit(0);
  });

// Default command - start interactive mode
if (process.argv.length === 2) {
  program.parse(['node', 'cli', 'start']);
} else {
  program.parse();
}
