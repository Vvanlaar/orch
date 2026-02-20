import App from './App.svelte';
import { mount } from 'svelte';
import './app.css';

const app = mount(App, {
  target: document.getElementById('app')!,
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (error) {
      console.error('Service worker registration failed:', error);
    }
  });
}

export default app;
