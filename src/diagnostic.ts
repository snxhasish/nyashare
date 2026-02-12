import { createSocket } from 'dgram';
import { networkInterfaces } from 'os';

const DISCOVERY_PORT = 41234;
const TEST_MESSAGE = 'NYASHARE_TEST';

console.log('🔍 NyaShare Discovery Diagnostic\n');

// List all network interfaces
console.log('📡 Network Interfaces:');
const nets = networkInterfaces();
const ipv4Interfaces: { name: string; address: string; internal: boolean }[] = [];

for (const name of Object.keys(nets)) {
  for (const net of nets[name] || []) {
    if (net.family === 'IPv4') {
      console.log(`   ${name}: ${net.address} ${net.internal ? '(internal)' : '(external)'}`);
      if (!net.internal) {
        ipv4Interfaces.push({ name, address: net.address, internal: net.internal });
      }
    }
  }
}

console.log('\n🎯 External IPv4 interfaces found:', ipv4Interfaces.length);

// Test UDP broadcast
console.log('\n🧪 Testing UDP broadcast...');

const socket = createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (msg, rinfo) => {
  console.log(`\n✅ Received message from ${rinfo.address}:${rinfo.port}: ${msg.toString()}`);
});

socket.on('error', (err) => {
  console.error(`\n❌ Socket error: ${err.message}`);
});

socket.bind(DISCOVERY_PORT, () => {
  console.log(`✅ Socket bound to port ${DISCOVERY_PORT}`);
  
  try {
    socket.setBroadcast(true);
    console.log('✅ Broadcast mode enabled');
    
    // Send test broadcast
    const message = `${TEST_MESSAGE}|TestDevice|3000`;
    socket.send(message, DISCOVERY_PORT, '255.255.255.255', (err) => {
      if (err) {
        console.error('❌ Failed to send broadcast:', err.message);
      } else {
        console.log('📤 Test broadcast sent to 255.255.255.255');
        console.log('   (If you run this on another device, you should see the message above)');
      }
    });
    
    // Also try broadcasting on specific interface
    if (ipv4Interfaces.length > 0) {
      const mainInterface = ipv4Interfaces.find(i => !i.name.startsWith('br-') && !i.name.startsWith('docker')) || ipv4Interfaces[0];
      console.log(`\n📤 Also sending on interface ${mainInterface.name} (${mainInterface.address})`);
      
      const broadcastAddr = mainInterface.address.replace(/\.\d+$/, '.255');
      socket.send(message, DISCOVERY_PORT, broadcastAddr, (err) => {
        if (err) {
          console.error('❌ Failed to send subnet broadcast:', err.message);
        } else {
          console.log(`✅ Subnet broadcast sent to ${broadcastAddr}`);
        }
      });
    }
    
    console.log('\n⏳ Listening for messages for 10 seconds...');
    console.log('   (Run this script on another device to test discovery)\n');
    
  } catch (err: any) {
    console.error('❌ Error:', err.message);
  }
});

// Keep alive for 10 seconds
setTimeout(() => {
  console.log('\n🛑 Closing socket...');
  socket.close();
  process.exit(0);
}, 10000);
