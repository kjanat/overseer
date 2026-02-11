import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	root: '.',
	publicDir: 'public',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
	},
	optimizeDeps: {
		include: ['@dagrejs/dagre', '@dagrejs/graphlib'],
	},
	server: {
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://localhost:6969',
				changeOrigin: true,
			},
			'/health': {
				target: 'http://localhost:6969',
				changeOrigin: true,
			},
		},
	},
});
