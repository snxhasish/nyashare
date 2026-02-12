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

function expandPath(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath === '~') {
    return os.homedir();
  }
  return inputPath;
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
  .description('CLI tool to quick share files over local network')
  .version('0.0.1');

program
  .command('start')
  .description('start the nyashare server and CLI')
  .action(async () => {

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

    const { server, discovery } = await startServer();

    spinner.succeed(
      chalk.green('server started')
    );

    const localIp = discovery.getLocalAddress();
    const port = 3000;

    console.log(chalk.green('running'), chalk.blue('nyashare'), chalk.green(`on ${chalk.blue.underline(getDeviceName())}`));

    console.log(chalk.gray(`share files through CLI or go to ${chalk.underline(`http://${localIp}:${port}/share\n`)}`));

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
          type: 'input',
          name: 'filePath',
          message: 'enter file or folder path to send:',
          validate: async (input: string) => {
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

        try {
          await transferService.sendFiles(files, targetDevice, (transfer) => {
            if (transfer.status === 'completed') {
              completed++;
              process.stdout.write(`\r${chalk.green('⏵')} Progress: ${completed}/${files.length} files completed`);
            }
          });

          console.log(chalk.green(`\n\n✅ successfully sent ${files.length} file(s) to ${targetDevice.name}!\n`));
        } catch (error) {
          console.error(chalk.red(`\n\n❌ failed to send files: ${error}\n`));
        }

        showPrompt();
      }
    };

    showPrompt();
  });

/**
program
  .command('send <path>')
  .description('send a file or folder to a device')
  .action(async (filePath: string) => {
    const expandedPath = expandPath(filePath);
    const resolvedPath = path.resolve(expandedPath);

    try {
      await fs.access(resolvedPath);
    } catch {
      console.error(chalk.red(`❌ path does not exist: ${filePath}`));
      process.exit(1);
    }

    const spinner = ora('starting server...').start();
    const { server, discovery } = await startServer();
    spinner.succeed('server started');

    const files = await getAllFiles(resolvedPath);
    console.log(chalk.cyan(`📁 found ${files.length} file(s) to send`));

    await new Promise(resolve => setTimeout(resolve, 3000));

    const devices = discovery.getDevices();

    if (devices.length === 0) {
      console.log(chalk.yellow('\n⚠️  no devices found. waiting 10 seconds...'));
      await new Promise(resolve => setTimeout(resolve, 10000));

      const updatedDevices = discovery.getDevices();
      if (updatedDevices.length === 0) {
        console.error(chalk.red('\n❌ no devices found. make sure other devices are running nyashare.'));
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
      message: 'choose a device to send to:',
      choices
    }]);

    console.log(chalk.cyan(`\n📤 sending to ${targetDevice.name}...`));

    const transferService = new FileTransferService();
    const transfers = await transferService.sendFiles(files, targetDevice, (transfer) => {
      if (transfer.progress % 10 === 0) {
        process.stdout.write(`\r${transfer.filename}: ${transfer.progress}%`);
      }
    });

    console.log(chalk.green(`\n✅ sent ${transfers.length} file(s) successfully!`));

    discovery.stop();
    server.stop();
    process.exit(0);
  });

*/

if (process.argv.length === 2) {
  program.parse(['node', 'cli', 'start']);
} else {
  program.parse();
}
