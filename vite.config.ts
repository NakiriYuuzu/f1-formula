import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** The local-CA certificate tools/lan-cert.sh writes: tilt steering needs a secure context on a phone. */
function lanCert() {
  const key = new URL('./.cert/lan.key', import.meta.url);
  const cert = new URL('./.cert/lan.crt', import.meta.url);
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error('dev:lan:https needs .cert/lan.key and .cert/lan.crt: run tools/lan-cert.sh first');
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export default defineConfig(({ mode }) => ({
  base: './',
  server:
    mode === 'lan-https'
      ? { port: 5173, host: true, https: lanCert(), allowedHosts: ['.local'] }
      : { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
}));
