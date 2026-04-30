import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 端口被占时直接报错，不自动漂移到 5174，避免双实例混乱
    // 开发态代理：App.tsx 走同源空字符串 + /api/* 、/api/proxy/* 都被转发到后端
    // 这样前端代码不需要区分开发/生产环境的后端地址（产物部署交给 Nginx）
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // 生产不出 sourcemap，避免源码结构被逻辑堆栈介露
  },
})
