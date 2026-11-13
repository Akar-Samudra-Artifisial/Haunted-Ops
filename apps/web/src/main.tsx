import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { apiBaseUrl } from './net/api.js';
import { parseDemoParam } from './scene/params.js';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App client={{ baseUrl: apiBaseUrl(), network: window }} demo={parseDemoParam(window.location.search, import.meta.env)} />
    </StrictMode>,
  );
}
