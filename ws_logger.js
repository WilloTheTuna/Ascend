const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8085');

ws.on('open', () => {
  console.log('Connected to RocketStats WebSocket server!');
});

ws.on('message', (data) => {
  console.log('Received message:');
  try {
    const json = JSON.parse(data.toString());
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.log(data.toString());
  }
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('Timeout waiting for message.');
  process.exit(1);
}, 3000);
