import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element — index.html and main.tsx are out of step.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
