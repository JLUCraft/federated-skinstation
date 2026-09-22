import { defineConfig } from 'vite';
export default defineConfig({root:'web',base:'/portal/',build:{outDir:'../dist',emptyOutDir:true},server:{proxy:{'/textures':'http://127.0.0.1:8080','/api':'http://127.0.0.1:8080','/authserver':'http://127.0.0.1:8080'}}});
