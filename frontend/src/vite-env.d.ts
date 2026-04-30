/// <reference types="vite/client" />

// 显式声明本项目用到的环境变量，给 `import.meta.env` 加类型
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
