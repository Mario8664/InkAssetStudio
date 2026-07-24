import { createApp } from 'vue';
import App from './app/App.vue';
import './app/style.css';

createApp(App).mount('#app');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js');
  });
}
