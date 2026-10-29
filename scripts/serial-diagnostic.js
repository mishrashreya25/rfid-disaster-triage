import { SerialPort } from 'serialport';

const path = process.argv[2] || 'COM25';
const durationMs = Number(process.argv[3] || 20000);
const port = new SerialPort({ path, baudRate: 115200, autoOpen: false, rtscts: false });
let total = 0;
let buffer = '';
port.on('data', chunk => {
  total += chunk.length;
  console.log(JSON.stringify({ bytes: chunk.length, text: chunk.toString('utf8'), hex: chunk.toString('hex') }));
  buffer = (buffer + chunk.toString('utf8')).slice(-4096);
});
port.on('error', error => console.error(error.message));
try {
  await new Promise((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => port.set({ dtr: false, rts: false }, error => error ? reject(error) : resolve()));
  console.log(`${path} open at 115200. DTR and RTS released. Listening for ${durationMs / 1000}s.`);
  if (process.argv.includes('--reset')) {
    await new Promise((resolve, reject) => port.set({ dtr: false, rts: true }, error => error ? reject(error) : resolve()));
    await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise((resolve, reject) => port.set({ dtr: false, rts: false }, error => error ? reject(error) : resolve()));
    console.log('Normal firmware reset requested; listening for boot and reader output.');
  }
  await new Promise(resolve => setTimeout(resolve, durationMs));
  console.log(JSON.stringify({ totalBytes: total, recentText: buffer }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (port.isOpen) await new Promise(resolve => port.close(resolve));
}
