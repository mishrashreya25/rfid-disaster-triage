import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': process.env.RFID_API_TARGET || 'http://127.0.0.1:3001',
      '/socket.io': { target: process.env.RFID_API_TARGET || 'http://127.0.0.1:3001', ws: true },
    },
  },
});
