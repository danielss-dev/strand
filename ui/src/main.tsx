import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { isTauri } from './lib/tauri';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/features.css';

if (isTauri()) document.documentElement.classList.add('tauri');

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
