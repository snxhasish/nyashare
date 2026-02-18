<div align="center">
    <img src="public/banner.png" alt="banner">
</div>

A CLI tool to share files over your local network. No internet required - just connect to the same WiFi router!

### [Discord Support Server](https://discord.gg/K6k6ebkJkx)

## Features

✨ **Zero Configuration** - Automatically discovers devices on your network  
📁 **File & Folder Sharing** - Send individual files or entire directories  
🌐 **Web UI** - Access through any browser at `http://IP:PORT/share`  
🔒 **Local Only** - Files never leave your local network  
📱 **Cross-Platform** - Works on macOS, Linux, and Windows

## Usage

```bash
npx nyashare
```

Or run locally after cloning [snxhasish/nyashare](https://github.com/snxhasish/nyashare):

```bash
npm install
npm run build
node dist/cli.js
```

## Usage

### Interactive Mode (Recommended)

Simply run:

```bash
npx nyashare
```

This starts the server and opens an interactive CLI where you can:

- Send files to discovered devices
- List available devices on the network
- Open the web UI in your browser

### Send Files via CLI

```bash
# Send a file
npx nyashare send /path/to/file.pdf

# Send a folder
npx nyashare send /path/to/folder
```

### Web Interface

Access the web UI from any device on your network:

```
http://<YOUR_IP>:3000/share
```

The CLI will display the exact URL when it starts.

## How It Works

1. **Discovery**: Uses UDP broadcast to find other devices running NyaShare on the same network
2. **Server**: Each device runs an Express server to handle file uploads/downloads
3. **Transfer**: Files are sent directly from device to device over HTTP
4. **Storage**: Received files are saved to `~/Downloads/nyashare/uploads/`

## Commands

| Command              | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `nyashare`           | Start interactive mode                                               |
| `nyashare start`     | Start the server and CLI (same as above)                             |
| `nyashare receive`   | Receive mode: start in receiver mode, accept or decline incoming req |
| `nyashare --help`    | Show help information                                                |
| `nyashare --version` | Show version number                                                  |

## Network Requirements

- All devices must be connected to the **same local network** (same router)
- No internet connection required
- Firewall must allow traffic on port 3000 (auto-configured) and UDP port 41234

## Project Structure

```
nyashare/
├── src/
│   ├── cli.ts          # CLI interface & commands
│   ├── server.ts       # Express server & file handling
│   ├── discovery.ts    # UDP device discovery
│   ├── transfer.ts     # File transfer logic
│   └── types.ts        # TypeScript interfaces
├── public/
│   ├── index.html      # Landing page
│   └── share.html      # File sharing web UI
├── dist/               # Compiled JavaScript
└── package.json
```

## Development

```bash
# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run type checking
npm run typecheck

# Run linting
npm run lint
```

## Troubleshooting

**No devices found?**

- Make sure all devices are on the same WiFi network
- Check that firewall isn't blocking UDP port 41234
- Try restarting the CLI on all devices

**Can't access web UI?**

- Verify the IP address shown in the CLI
- Check if port 3000 is available or if another service is using it
- The CLI automatically finds an available port if 3000 is taken

**File transfers failing?**

- Ensure both devices are still running nyashare
- Check disk space on the receiving device
- For large files, ensure stable network connection

## License

MIT
